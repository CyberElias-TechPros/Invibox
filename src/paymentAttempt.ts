export type PaymentAttempt = {
  key: string;
  fingerprint: string;
  reference?: string;
  status?: string;
};
export async function reservePaymentAttempt(
  storage: Pick<Storage, "getItem" | "setItem">,
  name: string,
  body: unknown,
): Promise<PaymentAttempt> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const fingerprint = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const raw = storage.getItem(name);
  if (raw) {
    const prior = JSON.parse(raw) as PaymentAttempt;
    if (!prior.key || !prior.fingerprint)
      throw new Error(
        "Saved checkout data is invalid. Contact the organizer before attempting another payment.",
      );
    if (prior.fingerprint !== fingerprint)
      throw new Error(
        "A previous contribution attempt has different details. Verify its status before starting another contribution.",
      );
    return prior;
  }
  const attempt = { key: crypto.randomUUID(), fingerprint };
  storage.setItem(name, JSON.stringify(attempt));
  return attempt;
}
