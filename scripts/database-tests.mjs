// SQLite-backed Worker tests for transactions, expiration and queue orchestration.
// Real Cloudflare binding behavior is additionally covered by test:regression.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const bundle=await build({entryPoints:['worker/src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022'});
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync('worker/migrations').sort())sqlite.exec(readFileSync('worker/migrations/'+name,'utf8'));
  const prepare=(sql,values=[])=>({
    bind:(...args)=>prepare(sql,args),
    first:async()=>sqlite.prepare(sql).get(...values)||null,
    all:async()=>({results:sqlite.prepare(sql).all(...values)}),
    run:async()=>{const result=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(result.changes)},results:[]}},
    execute:()=>{const query=sqlite.prepare(sql);if(query.columns().length)return {results:query.all(...values),meta:{changes:0}};const r=query.run(...values);return {results:[],meta:{changes:Number(r.changes)}}},
  });
  return {sqlite,prepare,batch:async stmts=>{sqlite.exec('BEGIN');try{const result=stmts.map(stmt=>stmt.execute());sqlite.exec('COMMIT');return result}catch(error){sqlite.exec('ROLLBACK');throw error}}};
}
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const makeEnv=DB=>({DB,APP_ENV:'development',APP_ORIGIN:'http://localhost:5173',DEMO_MODE:'true',NOTIFICATIONS:{send:async()=>{}},RESEND_API_KEY:'test-only',EMAIL_FROM:'events@example.com'});
const call=(env,path,body,cookie)=>worker.fetch(new Request('http://localhost/api/v1'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});

test('ISO-format expired sessions are rejected on the same calendar day',async()=>{
  const DB=database();DB.sqlite.exec("INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test')");
  await DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').bind('s','u',await sha('session'),new Date(Date.now()-60000).toISOString()).run();
  assert.equal((await call(makeEnv(DB),'/auth/me',undefined,'invibox_session=session')).status,401);
  DB.sqlite.close();
});
test('expired reset and team tokens reject ISO times without a midnight grace period',async()=>{
  const DB=database();DB.sqlite.exec("INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos')");
  const old=new Date(Date.now()-60000).toISOString(),token='x'.repeat(32);
  await DB.prepare('INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').bind('r','u',await sha(token),old).run();
  assert.equal((await call(makeEnv(DB),'/auth/password/reset',{token,password:'Strong-2026-password'})).status,400);
  await DB.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').bind('s','u',await sha('session'),new Date(Date.now()+60000).toISOString()).run();
  await DB.prepare('INSERT INTO team_invitations(id,event_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?,?)').bind('i','e','u@example.com','viewer',await sha(token),'u',old).run();
  assert.equal((await call(makeEnv(DB),'/team-invitations/accept',{token},'invibox_session=session')).status,403);
  DB.sqlite.close();
});
test('queue retries transient failures, preserves its audience and deduplicates replay',async()=>{
  const DB=database(),env=makeEnv(DB);
  DB.sqlite.exec("INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos');INSERT INTO guests(id,event_id,name,email,status) VALUES('g','e','Guest','guest@example.com','attending');INSERT INTO guests(id,event_id,name,email,status) VALUES('not-selected','e','Other','other@example.com','pending');INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES('a','e','u','email','pending','Hello');INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g')");
  let deliveries=0,acks=0,retries=0;
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{deliveries++;return new Response(JSON.stringify(deliveries===1?{}:{id:'accepted'}),{status:deliveries===1?429:200})};
  const message={body:{id:'a',eventId:'e',channel:'email',audience:'pending',message:'Hello',createdAt:new Date().toISOString()},ack(){acks++},retry(){retries++}};
  try{
    await worker.queue({messages:[message]},env);assert.equal(retries,1);assert.equal(acks,0);
    await worker.queue({messages:[message]},env);assert.equal(acks,1);assert.equal(deliveries,2);
    await worker.queue({messages:[message]},env);assert.equal(acks,2);assert.equal(deliveries,2);
    const row=DB.sqlite.prepare('SELECT * FROM notification_deliveries').get();assert.equal(row.status,'sent');assert.equal(row.attempts,2);assert.equal(row.guest_id,'g');
    assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM notification_leases').get().n,0);
  }finally{globalThis.fetch=original;DB.sqlite.close()}
});
test('signed payment webhooks validate currency and process retries atomically',async()=>{
  const DB=database(),env={...makeEnv(DB),PAYSTACK_SECRET_KEY:'test-webhook-key'};
  DB.sqlite.exec("INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos');INSERT INTO payments(id,event_id,provider,reference,purpose,amount_minor,status) VALUES('p','e','paystack','ref','gift',10000,'initialized')");
  const {createHmac}=await import('node:crypto');
  const send=async currency=>{const raw=JSON.stringify({event:'charge.success',data:{id:123,reference:'ref',amount:10000,currency,status:'success'}});return worker.fetch(new Request('http://localhost/api/v1/webhooks/paystack',{method:'POST',body:raw,headers:{'Content-Type':'application/json','x-paystack-signature':createHmac('sha512',env.PAYSTACK_SECRET_KEY).update(raw).digest('hex')}}),env,{waitUntil(){}})};
  assert.equal((await send('USD')).status,422);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM webhook_events').get().n,0);
  assert.equal((await send('NGN')).status,200);assert.equal(DB.sqlite.prepare('SELECT status FROM payments').get().status,'paid');
  assert.equal((await (await send('NGN')).json()).replayed,true);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM webhook_events').get().n,1);
  DB.sqlite.close();
});
