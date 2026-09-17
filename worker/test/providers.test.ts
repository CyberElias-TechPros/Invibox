import {afterEach,describe,expect,it,vi} from 'vitest';
import {ProviderConfigurationError,runAi,sendEmail,sendSms,sendWhatsApp} from '../src/providers';
import type {Bindings} from '../src/types';
const env=(values:Partial<Bindings>)=>values as Bindings;
afterEach(()=>vi.unstubAllGlobals());
const ok=(payload:unknown)=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
describe('provider adapters',()=>{
  it('fails explicitly when credentials are absent',async()=>{
    await expect(sendEmail(env({}),{name:'Ada',email:'ada@example.com'},'Hi','Subject')).rejects.toBeInstanceOf(ProviderConfigurationError);
    await expect(runAi(env({}),{system:'help',prompt:'draft'})).rejects.toBeInstanceOf(ProviderConfigurationError);
  });
  it('sends personalized Resend email',async()=>{const fetch=vi.fn().mockResolvedValue(ok({id:'mail_1'}));vi.stubGlobal('fetch',fetch);await sendEmail(env({RESEND_API_KEY:'key',EMAIL_FROM:'Events <hi@example.com>'}),{name:'Ada Okafor',email:'ada@example.com'},'Hello {{first_name}}','Welcome');expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({to:['ada@example.com'],subject:'Welcome',text:'Hello Ada'})});
  it('builds a WhatsApp template request',async()=>{const fetch=vi.fn().mockResolvedValue(ok({messages:[{id:'wa_1'}]}));vi.stubGlobal('fetch',fetch);await sendWhatsApp(env({WHATSAPP_ACCESS_TOKEN:'token',WHATSAPP_PHONE_NUMBER_ID:'123',WHATSAPP_TEMPLATE_NAME:'event_update'}),{name:'Chidi Obi',phone:'+234 800 000 0000'},'Update for {{guest_name}}');const body=JSON.parse(fetch.mock.calls[0][1].body);expect(body).toMatchObject({to:'2348000000000',type:'template',template:{name:'event_update'}})});
  it('uses Twilio form encoding',async()=>{const fetch=vi.fn().mockResolvedValue(ok({sid:'SM1'}));vi.stubGlobal('fetch',fetch);await sendSms(env({TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'secret',TWILIO_FROM_NUMBER:'+100'}),{name:'Kemi',phone:'+2341'},'Hi {{first_name}}');expect(String(fetch.mock.calls[0][1].body)).toContain('Body=Hi+Kemi')});
  it('returns OpenAI-compatible assistant content',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(ok({choices:[{message:{content:'  A polished draft  '}}]})));await expect(runAi(env({AI_API_KEY:'key'}),{system:'system',prompt:'prompt'})).resolves.toBe('A polished draft')});
  it('surfaces provider error messages',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'Rejected sender'}),{status:403})));await expect(sendEmail(env({RESEND_API_KEY:'key',EMAIL_FROM:'x@y.com'}),{name:'A',email:'a@b.com'},'Hi','Subject')).rejects.toThrow('Rejected sender')});
});
