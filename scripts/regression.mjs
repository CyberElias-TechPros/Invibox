import assert from 'node:assert/strict';
const base=process.env.BASE_URL||'http://localhost:5173/api/v1';
let count=0;
async function request(path,{cookie,body,method='GET',headers={},status=200}={}){
  const res=await fetch(base+path,{method,headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}
  assert.equal(res.status,status,`${method} ${path}: ${text}`);count++;
  return {data,cookie:res.headers.get('set-cookie')?.split(';')[0],headers:res.headers};
}
const suffix=crypto.randomUUID();
async function account(name){return request('/auth/register',{method:'POST',body:{name,email:`${name}-${suffix}@example.com`,password:'Regression-2026-strong!'},status:201})}
const host=await account('host'), other=await account('other'),staff=await account('staff');
const cookie=host.cookie;
async function event(){return (await request('/events',{cookie,method:'POST',body:{title:'Regression event',eventType:'conference',date:'2027-06-15',timezone:'America/New_York',location:'New York'},status:201})).data.event}
const a=await event(),b=await event();
const path=`/events/${a.id}`,bpath=`/events/${b.id}`;
const snapshot=async(p=path,c=cookie)=>(await request(p+'/snapshot',{cookie:c})).data;
await request(path+'/snapshot',{cookie:other.cookie,status:404});
await request(path,{cookie,method:'PATCH',body:{lifecycle:'published'},status:422});
await request(path+'/schedule/sync',{cookie,method:'PUT',body:{schedule:[]},status:428});
const schedule=[{id:'shared-local-id',date:'2027-06-16',time:'14:00',title:'Public session',place:'Hall',audience:'All guests'},{id:'private-session',date:'2027-06-17',time:'09:00',title:'Private session',place:'Private room',isPrivate:true}];
await request(path+'/schedule/sync',{cookie,method:'PUT',body:{schedule},headers:{'If-Match':'1'}});
let snap=await snapshot();assert.equal(snap.schedule[0].starts_at,'2027-06-16T18:00:00.000Z');assert.equal(snap.schedule[0].time,'14:00');count++;
await request(bpath+'/schedule/sync',{cookie,method:'PUT',body:{schedule},headers:{'If-Match':'1'}});
assert.notEqual((await snapshot(bpath)).schedule[0].id,snap.schedule[0].id);count++;
// Cross-tenant actual IDs must fail transactionally.
await request(bpath+'/schedule/sync',{cookie,method:'PUT',body:{schedule:snap.schedule},headers:{'If-Match':String((await snapshot(bpath)).event.schedule_version)},status:409});
await request(path,{cookie,method:'PATCH',body:{lifecycle:'published'}});
await request('/public/events/'+a.slug,{status:404});
const created=(await request(path+'/guests',{cookie,method:'POST',body:{name:'Guest One',email:'guest@example.com',phone:'+12025550123',party:2},status:201})).data;
const token=created.token, guestId=created.guest.id;
const invite=(await request(`/public/events/${a.slug}?token=${token}`)).data;
assert.equal(invite.occasions.length,1);assert.equal(invite.event.timezone,'America/New_York');count++;
await request(`/public/events/${a.slug}?token=${'x'.repeat(32)}`,{status:404});
const occ=invite.occasions[0].id;
const response={token,responses:[{occasionId:occ,status:'attending'}]};
const stale=await snapshot();
await request('/public/rsvp',{method:'POST',body:response,headers:{'Idempotency-Key':'case-1'}});
assert.equal((await request('/public/rsvp',{method:'POST',body:response,headers:{'Idempotency-Key':'case-1'}})).data.replayed,true);
await request('/public/rsvp',{method:'POST',body:{...response,responses:[{occasionId:occ,status:'declined'}]},headers:{'Idempotency-Key':'case-1'},status:409});
await request('/public/rsvp',{method:'POST',body:{token,responses:[{occasionId:snap.schedule[1].id,status:'attending'}]},status:403});
await request('/public/rsvp',{method:'POST',body:{token,responses:[response.responses[0],response.responses[0]]},status:422});
await request(path+'/guests/sync',{cookie,method:'PUT',body:{guests:stale.guests},headers:{'If-Match':String(stale.event.guests_version)},status:409});
const fresh=await snapshot();
const updates=await Promise.all([1,2].map(()=>fetch(base+path+'/guests/sync',{method:'PUT',headers:{cookie,'Content-Type':'application/json','If-Match':String(fresh.event.guests_version)},body:JSON.stringify({guests:fresh.guests})})));
assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);count++;
const poisoned=await snapshot();
await request(bpath+'/guests/sync',{cookie,method:'PUT',body:{guests:poisoned.guests},headers:{'If-Match':String((await snapshot(bpath)).event.guests_version)},status:409});
assert.equal((await snapshot()).guests[0].email,'guest@example.com');
// Atomic seat capacity, including competing requests.
await request(path+'/seating',{cookie,method:'POST',body:{name:'T1',capacity:2},status:201});
const second=(await request(path+'/guests',{cookie,method:'POST',body:{name:'Guest Two',party:2},status:201})).data;
const seatResults=await Promise.all([guestId,second.guest.id].map(id=>fetch(`${base}${path}/guests/${id}/seat`,{method:'PATCH',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({table:'T1'})})));
assert.deepEqual(seatResults.map(r=>r.status).sort(),[200,409]);count++;
// Role check and financial redaction.
const inviteStaff=(await request(path+'/team-invitations',{cookie,method:'POST',body:{email:`staff-${suffix}@example.com`,role:'checkin_staff'},status:201})).data;
assert.ok(inviteStaff.demoToken,'Run this local regression suite with DEMO_MODE=true');
await request('/team-invitations/accept',{cookie:staff.cookie,method:'POST',body:{token:inviteStaff.demoToken}});
const staffSnap=await snapshot(path,staff.cookie);assert.deepEqual(staffSnap.budgets,[]);assert.equal(staffSnap.guests[0].email,undefined);count++;
await request(path+'/checkin/scan',{cookie:staff.cookie,method:'POST',body:{token}});
assert.equal((await request(path+'/checkin/scan',{cookie:staff.cookie,method:'POST',body:{token}})).data.alreadyCheckedIn,true);
await request(path+'/guests/sync',{cookie:staff.cookie,method:'PUT',body:{guests:[]},headers:{'If-Match':'1'},status:403});
await request(path+'/team',{cookie:staff.cookie,status:403});
await request(path+'/team/'+staff.data.user.id,{cookie,method:'DELETE',status:204});
await request(path+'/snapshot',{cookie:staff.cookie,status:404});
// Origin, content type and malformed JSON errors.
await request(path,{cookie,method:'PATCH',body:{title:'CSRF'},headers:{Origin:'https://evil.example'},status:403});
const malformed=await fetch(base+path,{method:'PATCH',headers:{cookie,'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);count++;
const newToken=(await request(path+`/guests/${guestId}/token`,{cookie,method:'POST'})).data.token;
await request(`/public/events/${a.slug}?token=${token}`,{status:404});
await request(`/public/events/${a.slug}?token=${newToken}`);
// Clear all schedule rows, with no hard-coded empty-list exception.
const beforeClear=await snapshot(bpath);
await request(bpath+'/schedule/sync',{cookie,method:'PUT',body:{schedule:[]},headers:{'If-Match':String(beforeClear.event.schedule_version)}});
assert.equal((await snapshot(bpath)).schedule.length,0);count++;
await request(path,{cookie,method:'PATCH',body:{lifecycle:'live'}});
await request(path+'/schedule/sync',{cookie,method:'PUT',body:{schedule:[]},headers:{'If-Match':String((await snapshot()).event.schedule_version)},status:409});
await request(path,{cookie,method:'PATCH',body:{lifecycle:'draft'},status:409});
await request(path,{cookie,method:'PATCH',body:{lifecycle:'completed'}});
await request('/public/rsvp',{method:'POST',body:{token:newToken,responses:[{occasionId:occ,status:'declined'}]},status:409});
await request('/auth/logout',{cookie,method:'POST'});
await request('/auth/me',{cookie,status:401});
console.log(`Regression suite passed: ${count} checks (isolation, privacy, timezone, atomic writes, RSVP, RBAC, CSRF, lifecycle, revocation).`);
