import type { Bindings } from './types';

export class ProviderConfigurationError extends Error {}
export type Recipient={name:string;email?:string|null;phone?:string|null};
const interpolate=(message:string,recipient:Recipient)=>message.replaceAll('{{first_name}}',recipient.name.split(/\s+/)[0]||'Guest').replaceAll('{{guest_name}}',recipient.name);

async function providerFetch(url:string,init:RequestInit){
  const response=await fetch(url,init);
  const payload:any=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload?.message||payload?.error?.message||`Provider returned ${response.status}`);
  return payload;
}

export async function sendEmail(env:Bindings,to:Recipient,message:string,subject:string){
  if(!env.RESEND_API_KEY||!env.EMAIL_FROM)throw new ProviderConfigurationError('RESEND_API_KEY and EMAIL_FROM are required');
  if(!to.email)throw new Error('Guest has no email address');
  return providerFetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to.email],subject,text:interpolate(message,to)})});
}

export async function sendWhatsApp(env:Bindings,to:Recipient,message:string){
  if(!env.WHATSAPP_ACCESS_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID)throw new ProviderConfigurationError('WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required');
  if(!to.phone)throw new Error('Guest has no phone number');
  const phone=to.phone.replace(/[^0-9]/g,'');
  if(env.WHATSAPP_TEMPLATE_NAME){
    return providerFetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:env.WHATSAPP_TEMPLATE_NAME,language:{code:env.WHATSAPP_TEMPLATE_LANGUAGE||'en'},components:[{type:'body',parameters:[{type:'text',text:to.name.split(/\s+/)[0]||'Guest'},{type:'text',text:interpolate(message,to)}]}]}})});
  }
  return providerFetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:phone,type:'text',text:{preview_url:true,body:interpolate(message,to)}})});
}

export async function sendSms(env:Bindings,to:Recipient,message:string){
  if(!env.TWILIO_ACCOUNT_SID||!env.TWILIO_AUTH_TOKEN||!env.TWILIO_FROM_NUMBER)throw new ProviderConfigurationError('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are required');
  if(!to.phone)throw new Error('Guest has no phone number');
  const form=new URLSearchParams({To:to.phone,From:env.TWILIO_FROM_NUMBER,Body:interpolate(message,to)});
  return providerFetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,{method:'POST',headers:{Authorization:`Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,'Content-Type':'application/x-www-form-urlencoded'},body:form});
}

export async function sendNotification(env:Bindings,channel:'email'|'sms'|'whatsapp',recipient:Recipient,message:string,subject:string){
  if(channel==='email')return sendEmail(env,recipient,message,subject);
  if(channel==='whatsapp')return sendWhatsApp(env,recipient,message);
  return sendSms(env,recipient,message);
}

export async function runAi(env:Bindings,input:{system:string;prompt:string}){
  if(!env.AI_API_KEY)throw new ProviderConfigurationError('AI_API_KEY is required');
  const base=(env.AI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
  const payload=await providerFetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${env.AI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:env.AI_MODEL||'gpt-4o-mini',temperature:.7,max_tokens:1200,messages:[{role:'system',content:input.system},{role:'user',content:input.prompt}]})});
  const text=payload?.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw new Error('AI provider returned an empty response');
  return text.trim();
}
