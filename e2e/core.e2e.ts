import {test,expect} from '@playwright/test';

test('organizer edits persisted content and the guest sees only real assigned occasions',async({page,context})=>{
  const faults:string[]=[];page.on('pageerror',error=>faults.push(error.message));
  const email=`browser-${crypto.randomUUID()}@example.com`;
  const registered=await page.request.post('/api/v1/auth/register',{data:{name:'Browser Organizer',email,password:'Browser-Test-2026!'}});
  expect(registered.status()).toBe(201);
  const created=await page.request.post('/api/v1/events',{data:{title:'Annual Community Dinner',eventType:'custom',date:'2027-06-16',timezone:'America/New_York',location:'New York'}});
  const event=(await created.json()).event;
  const schedule=await page.request.put(`/api/v1/events/${event.id}/schedule/sync`,{headers:{'If-Match':'1'},data:{schedule:[{time:'18:00',date:'2027-06-16',title:'Community dinner',place:'Community Hall'}]}});
  expect(schedule.ok()).toBe(true);
  await page.goto('/app');
  await expect(page.getByText('Browser Organizer',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Experience',exact:true}).click();
  await page.getByRole('button',{name:'Add section',exact:true}).click();
  await page.getByLabel('Section heading').fill('Welcome, friends');
  await page.getByLabel('Content',{exact:true}).fill('Please arrive fifteen minutes before dinner.');
  await page.getByRole('button',{name:'Save content',exact:true}).click();
  await expect(page.getByText('Content is up to date.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Publish invitation',exact:true}).click();
  await expect(page.getByText('Invitation published. Share individual links from the guest list.')).toBeVisible();
  const guest=(await (await page.request.post(`/api/v1/events/${event.id}/guests`,{data:{name:'Ada Guest',party:1}})).json());
  // Guest browsing in a separate unauthenticated context.
  const guestContext=await context.browser()!.newContext();const guestPage=await guestContext.newPage();
  const base=new URL(page.url()).origin;
  await guestPage.goto(`${base}/invite/${event.slug}?token=${guest.token}`);
  await expect(guestPage.getByRole('heading',{name:'Annual Community Dinner',exact:true})).toBeVisible();
  await expect(guestPage.getByText('Please arrive fifteen minutes before dinner.')).toBeVisible();
  await expect(guestPage.getByText('Community dinner',{exact:true}).first()).toBeVisible();
  await expect(guestPage.getByText('Traditional ceremony',{exact:true})).toHaveCount(0);
  await guestPage.getByLabel('Accepts with pleasure').check();
  await guestPage.getByRole('button',{name:'Save my response'}).click();
  await expect(guestPage.getByRole('status')).toContainText('Your response has been saved');
  await guestPage.goto(`${base}/invite/${event.slug}`);
  // The invitation is remembered only within this guest session. A new context must be denied.
  const privateContext=await context.browser()!.newContext();const privatePage=await privateContext.newPage();
  await privatePage.goto(`${base}/invite/${event.slug}`);
  await expect(privatePage.getByRole('heading',{name:'Invitation unavailable'})).toBeVisible();
  await guestContext.close();await privateContext.close();expect(faults).toEqual([]);
});

test('an unauthenticated organizer never silently becomes the demo account',async({page})=>{
  await page.goto('/app');
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.getByText('Amaka Okafor',{exact:true})).toHaveCount(0);
});
