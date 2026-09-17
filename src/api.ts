const BASE=import.meta.env.VITE_API_BASE||'/api/v1';
export class ApiError extends Error{constructor(message:string,public status:number,public requestId?:string){super(message)}}
async function request<T>(path:string,init:RequestInit={}){const res=await fetch(`${BASE}${path}`,{credentials:'include',...init,headers:{'Content-Type':'application/json',...init.headers}});if(res.status===204)return undefined as T;const data=await res.json().catch(()=>({}));if(!res.ok)throw new ApiError(data?.error?.message||'Request failed',res.status,data?.requestId);return data as T}
export const api={
 bootstrap:()=>request<{eventId:string;guestToken:string}>('/demo/bootstrap',{method:'POST'}),
 me:()=>request<any>('/auth/me'),
 logout:()=>request('/auth/logout',{method:'POST'}),
 login:(email:string,password:string)=>request<any>('/auth/login',{method:'POST',body:JSON.stringify({email,password})}),
 register:(name:string,email:string,password:string)=>request<any>('/auth/register',{method:'POST',body:JSON.stringify({name,email,password})}),
 events:()=>request<any>('/events'),
 snapshot:(id:string)=>request<any>(`/events/${id}/snapshot`),
 createEvent:(body:unknown)=>request<any>('/events',{method:'POST',body:JSON.stringify(body)}),
 updateEvent:(id:string,body:unknown)=>request(`/events/${id}`,{method:'PATCH',body:JSON.stringify(body)}),
 syncSections:(id:string,sections:unknown[])=>request(`/events/${id}/sections/sync`,{method:'PUT',body:JSON.stringify({sections})}),
 addGuest:(id:string,guest:unknown)=>request<any>(`/events/${id}/guests`,{method:'POST',body:JSON.stringify(guest)}),
 syncGuests:(id:string,guests:unknown[])=>request(`/events/${id}/guests/sync`,{method:'PUT',body:JSON.stringify({guests})}),
 syncSchedule:(id:string,schedule:unknown[])=>request(`/events/${id}/schedule/sync`,{method:'PUT',body:JSON.stringify({schedule})}),
 scanPass:(eventId:string,token:string)=>request<any>(`/events/${eventId}/checkin/scan`,{method:'POST',body:JSON.stringify({token})}),
 checkin:(eventId:string,guestId:string|number,checkedIn:boolean)=>request(`/events/${eventId}/guests/${guestId}/checkin`,{method:'PATCH',body:JSON.stringify({checkedIn})}),
 addTable:(eventId:string,body:unknown)=>request(`/events/${eventId}/seating`,{method:'POST',body:JSON.stringify(body)}),
 assignSeat:(eventId:string,guestId:string|number,table:string|null)=>request(`/events/${eventId}/guests/${guestId}/seat`,{method:'PATCH',body:JSON.stringify({table})}),
 addBudget:(eventId:string,body:unknown)=>request(`/events/${eventId}/budgets`,{method:'POST',body:JSON.stringify(body)}),
 deleteBudget:(eventId:string,id:string)=>request(`/events/${eventId}/budgets/${id}`,{method:'DELETE'}),
 addVendor:(eventId:string,body:unknown)=>request(`/events/${eventId}/vendors`,{method:'POST',body:JSON.stringify(body)}),
 deleteVendor:(eventId:string,id:string)=>request(`/events/${eventId}/vendors/${id}`,{method:'DELETE'}),
 mediaUrl:(eventId:string,mediaId:string)=>`${BASE}/events/${eventId}/media/${mediaId}/file`,
 moderateMedia:(eventId:string,mediaId:string,status:'approved'|'rejected')=>request(`/events/${eventId}/media/${mediaId}`,{method:'PATCH',body:JSON.stringify({status})}),
 uploadMedia:async(eventId:string,file:File,caption='')=>{const form=new FormData();form.append('file',file);form.append('caption',caption);const res=await fetch(`${BASE}/events/${eventId}/media`,{method:'POST',credentials:'include',body:form});const data=await res.json();if(!res.ok)throw new ApiError(data?.error?.message||'Upload failed',res.status,data?.requestId);return data},
 announce:(eventId:string,body:unknown)=>request(`/events/${eventId}/announcements`,{method:'POST',body:JSON.stringify(body)}),
 publicEvent:(slug:string,token?:string)=>request<any>(`/public/events/${slug}${token?`?token=${encodeURIComponent(token)}`:''}`),
 rsvp:(body:unknown,key=crypto.randomUUID())=>request('/public/rsvp',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)}),
 analytics:(body:unknown)=>request('/public/analytics',{method:'POST',body:JSON.stringify(body)}),
 health:()=>request('/health')
};
