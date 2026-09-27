import { describe, it, expect } from "vitest";
import { reservePaymentAttempt } from "./paymentAttempt";
const storage = () => {
  const records = new Map<string, string>();
  return {
    getItem: (key: string) => records.get(key) || null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
  };
};
describe("browser payment retry state", () => {
  it("persists a stable key without persisting receipt emails or invitation tokens", async () => {
    const store = storage();
    const body = {
      email: "payer@example.com",
      token: "private-token",
      amount: 100,
    };
    const first = await reservePaymentAttempt(store, "payment", body);
    const second = await reservePaymentAttempt(store, "payment", body);
    expect(first.key).toBe(second.key);
    expect(store.getItem("payment")).not.toContain("payer@example.com");
    expect(store.getItem("payment")).not.toContain("private-token");
  });
  it("does not silently create another key when details change", async () => {
    const store = storage();
    const first = await reservePaymentAttempt(store, "payment", {
      amount: 100,
    });
    await expect(
      reservePaymentAttempt(store, "payment", { amount: 200 }),
    ).rejects.toThrow("previous contribution");
    expect(JSON.parse(store.getItem("payment")!).key).toBe(first.key);
  });
  it("fails closed on corrupted retry state rather than losing the previous payment", async () => {
    const store = storage();
    store.setItem("payment", "{}");
    await expect(reservePaymentAttempt(store, "payment", {})).rejects.toThrow(
      "invalid",
    );
  });
});
