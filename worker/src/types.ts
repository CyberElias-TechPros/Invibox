export type Bindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  CACHE: KVNamespace;
  NOTIFICATIONS: Queue<NotificationJob>;
  APP_ENV: string;
  APP_ORIGIN: string;
  DEMO_MODE: string;
  SESSION_PEPPER?: string;
  PAYSTACK_SECRET_KEY?: string;
};
export type Variables = { userId: string; requestId: string };
export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type NotificationJob = { id:string; eventId:string; channel:'email'|'sms'|'whatsapp'; audience:string; message:string; createdAt:string };
