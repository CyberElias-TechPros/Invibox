import {readFileSync,writeFileSync} from 'node:fs';
const required=['INVIBOX_APP_ORIGIN','INVIBOX_API_ORIGIN','CLOUDFLARE_D1_ID','CLOUDFLARE_KV_ID','R2_BUCKET','QUEUE_NAME'];
const missing=required.filter(name=>!process.env[name]);
if(missing.length){console.error(`Missing non-secret deployment settings: ${missing.join(', ')}. See docs/DEPLOYMENT.md.`);process.exit(1)}
const value=name=>process.env[name];
for(const key of ['INVIBOX_APP_ORIGIN','INVIBOX_API_ORIGIN']){
  const u=new URL(value(key));
  if(u.protocol!=='https:'||u.origin!==value(key)||u.username||u.password||/localhost|example\.|placeholder|your-/i.test(u.hostname))throw new Error(`${key} must be your real HTTPS origin with no path or trailing slash`);
}
if(!/^[0-9a-f-]{36}$/i.test(value('CLOUDFLARE_D1_ID')))throw new Error('CLOUDFLARE_D1_ID must be a provider-issued database UUID');
if(!/^[0-9a-f]{32}$/i.test(value('CLOUDFLARE_KV_ID')))throw new Error('CLOUDFLARE_KV_ID must be a provider-issued namespace ID');
for(const key of ['R2_BUCKET','QUEUE_NAME'])if(!/^[a-z0-9][a-z0-9-]{2,62}$/.test(value(key)))throw new Error(`${key} must be a valid lowercase resource name`);
if(process.argv.includes('--check')){console.log('Non-secret deployment settings are valid. Secrets, provider approval, resource existence and DNS must still be verified.');process.exit(0)}
let worker=readFileSync('wrangler.toml','utf8')
  .replace('APP_ENV = "development"','APP_ENV = "production"')
  .replace('APP_ORIGIN = "http://localhost:5173"',`APP_ORIGIN = ${JSON.stringify(value('INVIBOX_APP_ORIGIN'))}`)
  .replace('DEMO_MODE = "true"','DEMO_MODE = "false"')
  .replaceAll('local-invibox-db',value('CLOUDFLARE_D1_ID'))
  .replaceAll('local-cache-placeholder',value('CLOUDFLARE_KV_ID'))
  .replace(/bucket_name = "invibox-media"/,`bucket_name = "${value('R2_BUCKET')}"`)
  .replaceAll('invibox-notifications',value('QUEUE_NAME'))
  .replace('max_retries = 3',`max_retries = 3\ndead_letter_queue = "${value('QUEUE_NAME')}-dlq"`);
worker+='\n[observability]\nenabled = true\n';
const vercel=JSON.parse(readFileSync('vercel.json','utf8'));
vercel.rewrites=vercel.rewrites.filter(row=>row.source!=='/api/:path*');
vercel.rewrites.unshift({source:'/api/:path*',destination:`${value('INVIBOX_API_ORIGIN')}/api/:path*`});
writeFileSync('wrangler.production.toml',worker);
writeFileSync('vercel.json',JSON.stringify(vercel,null,2)+'\n');
console.log('Created wrangler.production.toml and configured the same-origin API rewrite in vercel.json. No secrets were written. Set Worker secrets using --config wrangler.production.toml, apply migrations, then deploy the Worker and frontend.');
