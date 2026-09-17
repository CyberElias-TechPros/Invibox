import type { Guest, ScheduleItem, BudgetItem } from './types';
export const initialGuests: Guest[] = [
 {id:1,name:'Kemi Adeyemi',initials:'KA',group:"Bride's family",status:'Attending',party:2,meal:'Jollof & chicken',checkedIn:true,table:'T12'},
 {id:2,name:'Tunde Okafor',initials:'TO',group:"Groom's family",status:'Attending',party:1,meal:'Vegetarian',checkedIn:false,table:'T04'},
 {id:3,name:'Nneka & Emeka Obi',initials:'NO',group:'Friends',status:'Pending',party:2,meal:'—',checkedIn:false},
 {id:4,name:'Ibrahim Bello',initials:'IB',group:'Colleagues',status:'Declined',party:1,meal:'—',checkedIn:false},
 {id:5,name:'The Afolabi Family',initials:'AF',group:'VIP',status:'Attending',party:5,meal:'Mixed',checkedIn:false,table:'T01'},
 {id:6,name:'Damilola George',initials:'DG',group:'Friends',status:'Pending',party:1,meal:'—',checkedIn:false},
 {id:7,name:'Chisom Nwosu',initials:'CN',group:'Church',status:'Attending',party:2,meal:'Jollof & fish',checkedIn:true,table:'T08'},
 {id:8,name:'Aunty Bola',initials:'AB',group:"Bride's family",status:'Attending',party:3,meal:'Mixed',checkedIn:false,table:'T02'},
];
export const initialSchedule: ScheduleItem[] = [
 {id:1,time:'10:00',title:'Traditional ceremony',place:'The Monarch Hall, Lekki',audience:'Family & VIP'},
 {id:2,time:'13:30',title:'White wedding',place:'Grace Pavilion, Victoria Island',audience:'All guests'},
 {id:3,time:'16:00',title:'Cocktail hour',place:'The Garden Terrace',audience:'All guests'},
 {id:4,time:'17:00',title:'Reception & dinner',place:'The Grand Ballroom',audience:'All guests'},
 {id:5,time:'21:30',title:'After party',place:'The Rooftop',audience:'Friends'},
];
export const budget: BudgetItem[] = [
 {name:'Venue & catering',spent:5800000,budget:7000000,color:'#6f7565'}, {name:'Decor & florals',spent:2100000,budget:2500000,color:'#a67c52'},
 {name:'Photo & video',spent:1450000,budget:1800000,color:'#c0a77b'}, {name:'Music & entertainment',spent:900000,budget:1200000,color:'#919986'},
 {name:'Attire & beauty',spent:1200000,budget:2000000,color:'#b98174'},
];
