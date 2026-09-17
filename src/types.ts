export type GuestStatus = 'Attending' | 'Pending' | 'Declined';
export interface Guest { id:number|string; name:string; initials:string; group:string; status:GuestStatus; party:number; meal:string; checkedIn:boolean; table?:string }
export interface ScheduleItem { id:number|string; time:string; title:string; place:string; audience:string }
export interface BudgetItem { name:string; spent:number; budget:number; color:string }
export type PageKey = 'overview'|'experience'|'guests'|'schedule'|'seating'|'messages'|'checkin'|'memories'|'budget'|'vendors'|'analytics'|'settings';
