const BASE = import.meta.env.VITE_API_BASE || "/api/v1";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(20000),
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      data?.error?.message || "Request failed",
      res.status,
      data?.requestId,
    );
  return data as T;
}
export const api = {
  audit: (id: string) => request<{ entries: any[] }>(`/events/${id}/audit`),
  consents: (id: string) =>
    request<{ entries: any[] }>(`/events/${id}/consents`),
  guestGallery: (slug: string, token: string, cursor = "") =>
    request<any>(
      `/public/events/${encodeURIComponent(slug)}/media?cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: `Guest ${token}` } },
    ),
  guestPhoto: async (
    slug: string,
    id: string,
    token: string,
    signal: AbortSignal,
  ) => {
    const response = await fetch(
      `${BASE}/public/events/${encodeURIComponent(slug)}/media/${encodeURIComponent(id)}/file`,
      { headers: { Authorization: `Guest ${token}` }, signal },
    );
    if (!response.ok) throw new Error("Photo unavailable");
    return response.blob();
  },
  uploadGuestPhoto: async (slug: string, token: string, data: FormData) => {
    const response = await fetch(
      `${BASE}/public/events/${encodeURIComponent(slug)}/media`,
      {
        method: "POST",
        headers: { Authorization: `Guest ${token}` },
        body: data,
        signal: AbortSignal.timeout(60000),
      },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || "Upload failed");
    return body;
  },
  withdrawGuestPhoto: (slug: string, id: string, token: string) =>
    request(
      `/public/events/${encodeURIComponent(slug)}/media/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { Authorization: `Guest ${token}` } },
    ),
  mfaStatus: () =>
    request<{
      enabled: boolean;
      available: boolean;
      recoveryCodesRemaining: number;
    }>("/account/mfa"),
  setupMfa: (password: string) =>
    request<{ secret: string; uri: string }>("/account/mfa/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  manageMfa: (
    action: "enable" | "disable" | "recovery",
    password: string,
    code: string,
  ) =>
    request<{ recoveryCodes?: string[]; signInRequired: boolean }>(
      `/account/mfa/${action}`,
      { method: "POST", body: JSON.stringify({ password, code }) },
    ),
  completeMfa: (challengeToken: string, code: string) =>
    request("/auth/mfa", {
      method: "POST",
      body: JSON.stringify({ challengeToken, code }),
    }),
  savePreferences: (
    token: string,
    preferences: { email: boolean; sms: boolean; whatsapp: boolean },
  ) =>
    request("/public/preferences", {
      method: "POST",
      body: JSON.stringify({ token, ...preferences }),
    }),
  unsubscribe: (body: { guest: string; channel: string; signature: string }) =>
    request<{ message: string }>("/public/unsubscribe", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  requestVerification: () =>
    request<any>("/auth/email/request", { method: "POST" }),
  verifyEmail: (token: string) =>
    request("/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  sessions: () => request<{ sessions: any[] }>("/account/sessions"),
  revokeSession: (id: string) =>
    request(`/account/sessions/${id}`, { method: "DELETE" }),
  revokeOtherSessions: (password: string) =>
    request("/account/sessions/revoke-others", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request("/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  deleteAccount: (password: string, confirmation: string) =>
    request("/account/delete", {
      method: "POST",
      body: JSON.stringify({ password, confirmation }),
    }),
  exportAccount: (password: string) =>
    request<any>("/account/export", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  exportEvent: (id: string, password: string) =>
    request<any>(`/events/${id}/export`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  eraseGuest: (id: string, guestId: string, password: string) =>
    request<any>(`/events/${id}/erase-guest/${guestId}`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  deleteEvent: (id: string, password: string, confirmation: string) =>
    request(`/events/${id}/delete`, {
      method: "POST",
      body: JSON.stringify({ password, confirmation }),
    }),
  payments: (id: string) => request<any>(`/events/${id}/payments`),
  reconcilePayment: (id: string, reference: string) =>
    request(
      `/events/${id}/payments/${encodeURIComponent(reference)}/reconcile`,
      { method: "POST" },
    ),
  bootstrap: () =>
    request<{ eventId: string; guestToken: string }>("/demo/bootstrap", {
      method: "POST",
    }),
  me: () => request<any>("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  forgotPassword: (email: string) =>
    request<any>("/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request("/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),
  login: (email: string, password: string) =>
    request<any>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (name: string, email: string, password: string) =>
    request<any>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    }),
  events: () => request<any>("/events"),
  snapshot: (id: string) => request<any>(`/events/${id}/snapshot`),
  createEvent: (body: unknown) =>
    request<any>("/events", { method: "POST", body: JSON.stringify(body) }),
  updateEvent: (id: string, body: unknown) =>
    request(`/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  syncSections: (id: string, sections: unknown[], version: number) =>
    request<{ version: number }>(`/events/${id}/sections/sync`, {
      method: "PUT",
      headers: { "If-Match": String(version) },
      body: JSON.stringify({ sections }),
    }),
  guestAccess: (id: string, guestId: string | number) =>
    request<{ occasionIds: string[] }>(
      `/events/${id}/guests/${guestId}/access`,
    ),
  setGuestAccess: (
    id: string,
    guestId: string | number,
    occasionIds: string[],
  ) =>
    request(`/events/${id}/guests/${guestId}/access`, {
      method: "PUT",
      body: JSON.stringify({ occasionIds }),
    }),
  team: (id: string) => request<any>(`/events/${id}/team`),
  removeMember: (id: string, userId: string) =>
    request(`/events/${id}/team/${userId}`, { method: "DELETE" }),
  revokeInvite: (id: string, inviteId: string) =>
    request(`/events/${id}/team-invitations/${inviteId}`, { method: "DELETE" }),
  rotateGuestToken: (id: string, guestId: string | number) =>
    request<{ token: string; url: string }>(
      `/events/${id}/guests/${guestId}/token`,
      { method: "POST" },
    ),
  addGuest: (id: string, guest: unknown) =>
    request<any>(`/events/${id}/guests`, {
      method: "POST",
      body: JSON.stringify(guest),
    }),
  syncGuests: (id: string, guests: unknown[], version: number) =>
    request<{ version: number }>(`/events/${id}/guests/sync`, {
      method: "PUT",
      headers: { "If-Match": String(version) },
      body: JSON.stringify({ guests }),
    }),
  syncSchedule: (id: string, schedule: unknown[], version: number) =>
    request<{ version: number }>(`/events/${id}/schedule/sync`, {
      method: "PUT",
      headers: { "If-Match": String(version) },
      body: JSON.stringify({ schedule }),
    }),
  scanPass: (eventId: string, token: string) =>
    request<any>(`/events/${eventId}/checkin/scan`, {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  checkin: (eventId: string, guestId: string | number, checkedIn: boolean) =>
    request(`/events/${eventId}/guests/${guestId}/checkin`, {
      method: "PATCH",
      body: JSON.stringify({ checkedIn }),
    }),
  addTable: (eventId: string, body: unknown) =>
    request(`/events/${eventId}/seating`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  assignSeat: (
    eventId: string,
    guestId: string | number,
    table: string | null,
  ) =>
    request(`/events/${eventId}/guests/${guestId}/seat`, {
      method: "PATCH",
      body: JSON.stringify({ table }),
    }),
  addBudget: (eventId: string, body: unknown) =>
    request(`/events/${eventId}/budgets`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteBudget: (eventId: string, id: string) =>
    request(`/events/${eventId}/budgets/${id}`, { method: "DELETE" }),
  addVendor: (eventId: string, body: unknown) =>
    request(`/events/${eventId}/vendors`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteVendor: (eventId: string, id: string) =>
    request(`/events/${eventId}/vendors/${id}`, { method: "DELETE" }),
  mediaUrl: (eventId: string, mediaId: string) =>
    `${BASE}/events/${eventId}/media/${mediaId}/file`,
  moderateMedia: (
    eventId: string,
    mediaId: string,
    status: "pending" | "approved" | "rejected",
    shareWithGuests?: boolean,
  ) =>
    request(`/events/${eventId}/media/${mediaId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, shareWithGuests }),
    }),
  uploadMedia: async (eventId: string, file: File, caption = "") => {
    const form = new FormData();
    form.append("file", file);
    form.append("caption", caption);
    const res = await fetch(`${BASE}/events/${eventId}/media`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const data = await res.json();
    if (!res.ok)
      throw new ApiError(
        data?.error?.message || "Upload failed",
        res.status,
        data?.requestId,
      );
    return data;
  },
  integrationStatus: (eventId: string) =>
    request<Record<string, boolean>>(`/events/${eventId}/integrations/status`),
  aiAssist: (eventId: string, task: string, prompt: string) =>
    request<{ answer: string }>(`/events/${eventId}/ai/assist`, {
      method: "POST",
      body: JSON.stringify({ task, prompt }),
    }),
  inviteTeam: (eventId: string, email: string, role: string) =>
    request<{ ok: boolean; delivered: boolean; demoToken?: string }>(
      `/events/${eventId}/team-invitations`,
      { method: "POST", body: JSON.stringify({ email, role }) },
    ),
  acceptTeamInvite: (token: string) =>
    request("/team-invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  announcements: (id: string) =>
    request<{ announcements: any[] }>(`/events/${id}/announcements`),
  retryAnnouncement: (id: string, announcementId: string) =>
    request(`/events/${id}/announcements/${announcementId}/retry`, {
      method: "POST",
    }),
  announce: (eventId: string, body: unknown) =>
    request(`/events/${eventId}/announcements`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  previewEvent: (id: string) => request<any>(`/events/${id}/preview`),
  publicEvent: (slug: string, token?: string) =>
    request<any>(
      `/public/events/${slug}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    ),
  rsvp: (body: unknown, key: string = crypto.randomUUID()) =>
    request("/public/rsvp", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  initializePayment: (
    body: {
      slug: string;
      token?: string;
      email: string;
      amount: number;
      purpose: string;
    },
    key: string,
  ) =>
    request<{
      checkoutUrl?: string;
      reference: string;
      status: string;
      message?: string;
    }>("/public/payments/paystack/initialize", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  paymentStatus: (reference: string) =>
    request<{ status: string; amount: number; purpose: string }>(
      `/public/payments/${encodeURIComponent(reference)}`,
    ),
  analytics: (body: unknown) =>
    request("/public/analytics", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  health: () => request("/health"),
  // Subscriptions
  subscriptionCatalog: () => request<any>("/subscriptions/catalog"),
  mySubscriptions: () => request<any>("/account/subscriptions"),
  checkoutSubscription: (body: any, key: string) =>
    request<any>("/account/subscriptions/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  reconcileSubscription: (ref: string) =>
    request(`/account/subscriptions/${encodeURIComponent(ref)}/reconcile`, { method: "POST" }),
  cancelSubscription: (ref: string, body: any) =>
    request(`/account/subscriptions/${encodeURIComponent(ref)}/cancel`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  invoices: () => request<any>("/account/invoices"),
  // Ownership transfer
  transferOwnership: (eventId: string, body: any) =>
    request(`/events/${eventId}/transfer`, { method: "POST", body: JSON.stringify(body) }),
  transfers: (eventId: string) => request<any>(`/events/${eventId}/transfers`),
  acceptTransfer: (transferId: string, body: any) =>
    request(`/transfers/${transferId}/accept`, { method: "POST", body: JSON.stringify(body) }),
  rejectTransfer: (transferId: string) =>
    request(`/transfers/${transferId}/reject`, { method: "POST" }),
  // Refunds
  requestRefund: (eventId: string, body: any) =>
    request(`/events/${eventId}/refunds`, { method: "POST", body: JSON.stringify(body) }),
  listRefunds: (eventId: string) => request<any>(`/events/${eventId}/refunds`),
  adminRefunds: () => request<any>("/admin/refunds"),
  approveRefund: (id: string, body: any) =>
    request(`/admin/refunds/${id}/approve`, { method: "POST", body: JSON.stringify(body) }),
  processRefund: (id: string, body: any) =>
    request(`/admin/refunds/${id}/process`, { method: "POST", body: JSON.stringify(body) }),
  rejectRefund: (id: string, body: any) =>
    request(`/admin/refunds/${id}/reject`, { method: "POST", body: JSON.stringify(body) }),
  // Tickets
  ticketTypes: (eventId: string) => request<any>(`/events/${eventId}/tickets`),
  createTicketType: (eventId: string, body: any) =>
    request(`/events/${eventId}/tickets`, { method: "POST", body: JSON.stringify(body) }),
  deleteTicketType: (eventId: string, typeId: string) =>
    request(`/events/${eventId}/tickets/${typeId}`, { method: "DELETE" }),
  holdTicket: (eventId: string, body: any) =>
    request(`/events/${eventId}/tickets/hold`, { method: "POST", body: JSON.stringify(body) }),
  confirmTicket: (eventId: string, body: any) =>
    request(`/events/${eventId}/tickets/confirm`, { method: "POST", body: JSON.stringify(body) }),
  // Extras
  transportBookings: (eventId: string) => request<any>(`/events/${eventId}/transport`),
  createTransport: (eventId: string, body: any) =>
    request(`/events/${eventId}/transport`, { method: "POST", body: JSON.stringify(body) }),
  accommodations: (eventId: string) => request<any>(`/events/${eventId}/accommodations`),
  createAccommodation: (eventId: string, body: any) =>
    request(`/events/${eventId}/accommodations`, { method: "POST", body: JSON.stringify(body) }),
  assignAccommodation: (eventId: string, accId: string, body: any) =>
    request(`/events/${eventId}/accommodations/${accId}/assign`, { method: "POST", body: JSON.stringify(body) }),
  registryItems: (eventId: string) => request<any>(`/events/${eventId}/registry`),
  createRegistryItem: (eventId: string, body: any) =>
    request(`/events/${eventId}/registry`, { method: "POST", body: JSON.stringify(body) }),
  fulfillRegistry: (eventId: string, itemId: string, body: any) =>
    request(`/events/${eventId}/registry/${itemId}/fulfill`, { method: "POST", body: JSON.stringify(body) }),
  waitlist: (eventId: string) => request<any>(`/events/${eventId}/waitlist`),
  createWaitlist: (eventId: string, body: any) =>
    request(`/events/${eventId}/waitlist`, { method: "POST", body: JSON.stringify(body) }),
  inviteWaitlist: (eventId: string, entryId: string) =>
    request(`/events/${eventId}/waitlist/${entryId}/invite`, { method: "POST" }),
  // Messaging callbacks
  suppressions: () => request<any>("/admin/suppressions"),
  // Retention
  retentionPolicies: () => request<any>("/admin/retention"),
  updateRetention: (category: string, body: any) =>
    request(`/admin/retention/${category}`, { method: "PATCH", body: JSON.stringify(body) }),
  // Offline check-in
  offlineSync: (eventId: string, body: any) =>
    request(`/events/${eventId}/checkin/offline/sync`, { method: "POST", body: JSON.stringify(body) }),
  offlinePending: (eventId: string) => request<any>(`/events/${eventId}/checkin/offline/pending`),
  // Drafts
  drafts: (eventId: string) => request<any>(`/events/${eventId}/drafts`),
  saveDraft: (eventId: string, body: any) =>
    request(`/events/${eventId}/drafts`, { method: "POST", body: JSON.stringify(body) }),
  deleteDraft: (eventId: string, draftId: string) =>
    request(`/events/${eventId}/drafts/${draftId}`, { method: "DELETE" }),
  // Themes
  themes: (eventId: string) => request<any>(`/events/${eventId}/themes`),
  createTheme: (eventId: string, body: any) =>
    request(`/events/${eventId}/themes`, { method: "POST", body: JSON.stringify(body) }),
  applyTheme: (eventId: string, themeId: string) =>
    request(`/events/${eventId}/themes/${themeId}/apply`, { method: "PUT" }),
  translations: (eventId: string) => request<any>(`/events/${eventId}/translations`),
  saveTranslations: (eventId: string, body: any) =>
    request(`/events/${eventId}/translations`, { method: "PUT", body: JSON.stringify(body) }),
  // Scheduled
  scheduled: (eventId: string) => request<any>(`/events/${eventId}/scheduled`),
  scheduleAnnouncement: (eventId: string, announcementId: string, body: any) =>
    request(`/events/${eventId}/announcements/${announcementId}/schedule`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelScheduled: (eventId: string, schedId: string) =>
    request(`/events/${eventId}/scheduled/${schedId}`, { method: "DELETE" }),
  // WebAuthn
  webauthnRegisterOptions: () => request<any>("/account/webauthn/register/options", { method: "POST" }),
  webauthnRegisterVerify: (body: any) =>
    request("/account/webauthn/register/verify", { method: "POST", body: JSON.stringify(body) }),
  webauthnList: () => request<any>("/account/webauthn/credentials"),
  webauthnDelete: (id: string) =>
    request(`/account/webauthn/credentials/${id}`, { method: "DELETE" }),
  webauthnAuthOptions: () => request<any>("/auth/webauthn/authentication/options", { method: "POST" }),
  webauthnAuthVerify: (body: any) =>
    request("/auth/webauthn/authentication/verify", { method: "POST", body: JSON.stringify(body) }),
};
