import { describe,it,expect } from 'vitest';
import { guestSchema,scheduleSchema,announcementSchema } from '../src/validation';
describe('domain validation',()=>{
 it('accepts valid guest and applies defaults',()=>expect(guestSchema.parse({name:'Kemi Adeyemi'}).party).toBe(1));
 it('rejects impossible party sizes',()=>expect(()=>guestSchema.parse({name:'Kemi',party:31})).toThrow());
 it('rejects malformed schedule times',()=>expect(()=>scheduleSchema.parse({time:'27:00',title:'Dinner',place:'Lagos'})).toThrow());
 it('prevents empty announcements',()=>expect(()=>announcementSchema.parse({channel:'email',audience:'all',message:' '})).toThrow());
});
