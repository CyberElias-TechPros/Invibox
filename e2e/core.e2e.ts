import { test as base, expect } from "@playwright/test";
// Each story models a separate client; unrelated CI users must not share the local IP's auth bucket.
// Cloudflare supplies this header in production. This override is for the local Worker fixture only.
const test = base.extend({
  extraHTTPHeaders: async ({}, use) => {
    const bytes = crypto.getRandomValues(new Uint8Array(2));
    await use({ "cf-connecting-ip": `198.18.${bytes[0]}.${bytes[1]}` });
  },
});

test("organizer edits persisted content and the guest sees only real assigned occasions", async ({
  page,
  context,
}) => {
  const faults: string[] = [];
  page.on("pageerror", (error) => faults.push(error.message));
  const email = `browser-${crypto.randomUUID()}@example.com`;
  const registered = await page.request.post("/api/v1/auth/register", {
    data: { name: "Browser Organizer", email, password: "Browser-Test-2026!" },
  });
  expect(registered.status()).toBe(201);
  const created = await page.request.post("/api/v1/events", {
    data: {
      title: "Annual Community Dinner",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "America/New_York",
      location: "New York",
    },
  });
  const event = (await created.json()).event;
  const schedule = await page.request.put(
    `/api/v1/events/${event.id}/schedule/sync`,
    {
      headers: { "If-Match": "1" },
      data: {
        schedule: [
          {
            time: "18:00",
            date: "2027-06-16",
            title: "Community dinner",
            place: "Community Hall",
          },
        ],
      },
    },
  );
  expect(schedule.ok()).toBe(true);
  await page.goto("/app");
  await expect(
    page.getByText("Browser Organizer", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Experience", exact: true }).click();
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByLabel("Section heading").fill("Welcome, friends");
  await page
    .getByLabel("Content", { exact: true })
    .fill("Please arrive fifteen minutes before dinner.");
  await page.getByRole("button", { name: "Save content", exact: true }).click();
  await expect(
    page.getByText("Content is up to date.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish invitation", exact: true })
    .click();
  await expect(
    page.getByText(
      "Invitation published. Share individual links from the guest list.",
    ),
  ).toBeVisible();
  const guest = await (
    await page.request.post(`/api/v1/events/${event.id}/guests`, {
      data: { name: "Ada Guest", party: 1 },
    })
  ).json();
  // Guest browsing in a separate unauthenticated context.
  const guestContext = await context
    .browser()!
    .newContext({ viewport: { width: 390, height: 844 } });
  const guestPage = await guestContext.newPage();
  const base = new URL(page.url()).origin;
  await guestPage.goto(`${base}/invite/${event.slug}?token=${guest.token}`);
  await expect(
    guestPage.getByRole("heading", {
      name: "Annual Community Dinner",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    guestPage.getByText("Please arrive fifteen minutes before dinner."),
  ).toBeVisible();
  await expect(
    guestPage.getByText("Community dinner", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    guestPage.getByText("Traditional ceremony", { exact: true }),
  ).toHaveCount(0);
  await expect(
    guestPage.getByAltText("Private check-in QR pass for Ada Guest"),
  ).toHaveAttribute("src", /^data:image\/png/);
  expect(
    await guestPage.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await guestPage.screenshot({
    path: "test-results/guest-mobile.png",
    fullPage: true,
  });
  await guestPage.getByLabel("Email updates", { exact: true }).check();
  await guestPage
    .getByRole("button", { name: "Save message preferences" })
    .click();
  await expect(
    guestPage.getByText("Your message preferences have been saved.", {
      exact: false,
    }),
  ).toBeVisible();
  await guestPage.getByLabel("Accepts with pleasure").check();
  await guestPage.getByRole("button", { name: "Save my response" }).click();
  await expect(
    guestPage
      .getByRole("status")
      .filter({ hasText: "Your response has been saved" }),
  ).toBeVisible();
  await guestPage.goto(`${base}/invite/${event.slug}`);
  // The invitation is remembered only within this guest session. A new context must be denied.
  const privateContext = await context.browser()!.newContext();
  const privatePage = await privateContext.newPage();
  await privatePage.goto(`${base}/invite/${event.slug}`);
  await expect(
    privatePage.getByRole("heading", { name: "Invitation unavailable" }),
  ).toBeVisible();
  await guestContext.close();
  await privateContext.close();
  expect(faults).toEqual([]);
});

test("an unauthenticated organizer never silently becomes the demo account", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Amaka Okafor", { exact: true })).toHaveCount(0);
});

test("account verification, export, and password changes are reachable without owning an event", async ({
  page,
}) => {
  const email = `account-${crypto.randomUUID()}@example.com`,
    password = "Account-Password-2026!";
  const registration = await page.request.post("/api/v1/auth/register", {
    data: { name: "Security Test", email, password },
  });
  expect(registration.status()).toBe(201);
  await page.goto("/app/account");
  await expect(
    page.getByRole("heading", { name: "Account & security" }),
  ).toBeVisible();
  const verification = await page.request.post("/api/v1/auth/email/request", {
    data: {},
  });
  expect(verification.status()).toBe(200);
  const { demoToken } = await verification.json();
  expect(demoToken).toBeTruthy();
  await page.goto(`/app?verify=${demoToken}`);
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your email is verified",
  );
  await page.goto("/app/account");
  await expect(
    page.getByText("Your email is verified.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my account" }).click();
  const file = await downloadPromise;
  expect(file.suggestedFilename()).toBe("invibox-account.json");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page
    .getByLabel("New password", { exact: true })
    .fill("Changed-Password-2026!");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const oldLogin = await page.request.post("/api/v1/auth/login", {
    maxRetries: 2,
    data: { email, password },
  });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await page.request.post("/api/v1/auth/login", {
    maxRetries: 2,
    data: { email, password: "Changed-Password-2026!" },
  });
  expect(newLogin.status()).toBe(200);
});

test("owner can export, erase a guest and delete an archived nonfinancial event", async ({
  page,
}) => {
  const password = "Privacy-Password-2026!";
  const registration = await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Privacy Owner",
      email: `privacy-${crypto.randomUUID()}@example.com`,
      password,
    },
  });
  expect(registration.status()).toBe(201);
  const created = await page.request.post("/api/v1/events", {
    data: {
      title: "Privacy test event",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "Africa/Lagos",
      location: "Lagos",
    },
  });
  const event = (await created.json()).event;
  const guest = await page.request.post(`/api/v1/events/${event.id}/guests`, {
    data: { name: "Guest to erase", email: "erase@example.com" },
  });
  expect(guest.status()).toBe(201);
  const archived = await page.request.patch(`/api/v1/events/${event.id}`, {
    data: { lifecycle: "archived" },
  });
  expect(archived.status()).toBe(200);
  await page.goto("/app");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Privacy & data management" }),
  ).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export event data", exact: true })
    .click();
  expect((await downloadPromise).suggestedFilename()).toContain("-export.json");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page
    .getByRole("combobox", { name: "Guest to erase", exact: true })
    .selectOption({ label: "Guest to erase" });
  await page.getByRole("button", { name: "Erase selected guest" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Guest links are revoked" }),
  ).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page
    .getByLabel("Type “Privacy test event” to confirm")
    .fill("Privacy test event");
  await page
    .getByRole("button", { name: "Permanently delete event", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create my event", exact: true }),
  ).toBeVisible();
});

test("account deletion is password confirmed and returns to sign-in", async ({
  page,
}) => {
  const email = `erase-account-${crypto.randomUUID()}@example.com`,
    password = "Deletion-Password-2026!";
  const response = await page.request.post("/api/v1/auth/register", {
    data: { name: "Account to erase", email, password },
  });
  expect(response.status()).toBe(201);
  await page.goto("/app/account");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("Type your account email", { exact: true }).fill(email);
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.post("/api/v1/auth/login", {
        data: { email, password },
      })
    ).status(),
  ).toBe(401);
});

test("checkout retries preserve intent and restore the receipt after reload (mocked provider boundary)", async ({
  page,
}) => {
  const registered = await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Payment Organizer",
      email: `payment-${crypto.randomUUID()}@example.com`,
      password: "Payment-Password-2026!",
    },
  });
  expect(registered.status()).toBe(201);
  const created = await page.request.post("/api/v1/events", {
    data: {
      title: "Contribution test",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "Africa/Lagos",
      location: "Lagos",
    },
  });
  const event = (await created.json()).event;
  expect(
    (
      await page.request.put(`/api/v1/events/${event.id}/schedule/sync`, {
        headers: { "If-Match": "1" },
        data: { schedule: [{ time: "18:00", title: "Dinner", place: "Hall" }] },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.patch(`/api/v1/events/${event.id}`, {
        data: { lifecycle: "published", settings: { capabilities: ["gifts"] } },
      })
    ).status(),
  ).toBe(200);
  const guest = await (
    await page.request.post(`/api/v1/events/${event.id}/guests`, {
      data: { name: "Contributing guest" },
    })
  ).json();
  const keys: string[] = [];
  await page.route(
    "**/api/v1/public/payments/paystack/initialize",
    async (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      await route.fulfill({
        status: 202,
        json: {
          reference: `browser-payment-${new Set(keys).size}`,
          status: "pending",
          message: "Payment pending reconciliation.",
        },
      });
    },
  );
  await page.route("**/api/v1/public/payments/browser-payment-1", (route) =>
    route.fulfill({
      json: { status: "paid", amount: 100, purpose: "contribution" },
    }),
  );
  await page.goto(`/invite/${event.slug}?token=${guest.token}`);
  await page
    .getByLabel("Receipt email", { exact: true })
    .fill("payer@example.com");
  await page.getByLabel("Amount (NGN)", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Continue to Paystack" }).click();
  await expect(
    page.getByText("Payment pending reconciliation.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue to Paystack" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByLabel("Amount (NGN)", { exact: true }).fill("200");
  await page.getByRole("button", { name: "Continue to Paystack" }).click();
  await expect(
    page.getByText("A previous contribution attempt has different details.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start another contribution" }),
  ).toBeVisible();
  await expect(
    page.getByText("Thank you — your contribution was received.", {
      exact: false,
    }),
  ).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Start another contribution" })
    .click();
  await page
    .getByLabel("Receipt email", { exact: true })
    .fill("payer@example.com");
  await page.getByLabel("Amount (NGN)", { exact: true }).fill("200");
  await page.getByRole("button", { name: "Continue to Paystack" }).click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[0]);
});

test("authenticator enrollment, recovery sign-in and disabling are wired end to end", async ({
  page,
}) => {
  const { totp } = await import("../worker/src/totp");
  const email = `mfa-${crypto.randomUUID()}@example.com`,
    password = "Authenticator-Password-2026!";
  expect(
    (
      await page.request.post("/api/v1/auth/register", {
        data: { name: "MFA Owner", email, password },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/app/account");
  await page.getByLabel("Password for authenticator changes").fill(password);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await expect(page.getByAltText("Authenticator setup QR")).toHaveAttribute(
    "src",
    /^data:image\/png/,
  );
  const secret = (await page.locator("code.recovery-codes").textContent())!;
  await page
    .getByLabel("Authenticator or recovery code")
    .fill(await totp(secret, Math.floor(Date.now() / 30000)));
  await page.getByRole("button", { name: "Confirm and enable MFA" }).click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery codes now" }),
  ).toBeVisible();
  const codes = (await page.locator("pre.recovery-codes").textContent())!
    .trim()
    .split("\n");
  expect(codes).toHaveLength(10);
  await page
    .getByRole("button", { name: "I saved my codes — sign in" })
    .click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm your sign-in" }),
  ).toBeVisible();
  await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify sign-in" }).click();
  await expect(
    page.getByRole("button", { name: "Create my event" }),
  ).toBeVisible();
  await page.goto("/app/account");
  await expect(
    page.getByText("Enabled · 9 recovery codes remaining"),
  ).toBeVisible();
  await page.getByLabel("Password for authenticator changes").fill(password);
  await page.getByLabel("Authenticator or recovery code").fill(codes[1]);
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Disable MFA" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("invited guests submit, staff moderate and guests withdraw shared photos", async ({
  page,
  context,
}) => {
  const password = "Photo-Owner-Password-2026!";
  await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Photo Owner",
      email: `photos-${crypto.randomUUID()}@example.com`,
      password,
    },
  });
  const event = (
    await (
      await page.request.post("/api/v1/events", {
        data: {
          title: "Guest photo event",
          eventType: "custom",
          date: "2027-06-16",
          timezone: "Africa/Lagos",
          location: "Lagos",
        },
      })
    ).json()
  ).event;
  await page.request.put(`/api/v1/events/${event.id}/schedule/sync`, {
    headers: { "If-Match": "1" },
    data: { schedule: [{ title: "Dinner", time: "18:00", place: "Hall" }] },
  });
  await page.request.patch(`/api/v1/events/${event.id}`, {
    data: { lifecycle: "published" },
  });
  const guest = await (
    await page.request.post(`/api/v1/events/${event.id}/guests`, {
      data: { name: "Photographer guest" },
    })
  ).json();
  const other = await (
    await page.request.post(`/api/v1/events/${event.id}/guests`, {
      data: { name: "Viewing guest" },
    })
  ).json();
  await page.goto("/app");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Allow guest photo uploads").check();
  await page
    .getByLabel("Show approved, shareable photos to invited guests")
    .check();
  await page.getByRole("button", { name: "Save photo settings" }).click();
  await expect(page.getByText("Guest photo settings saved.")).toBeVisible();
  const base = new URL(page.url()).origin,
    guestContext = await context.browser()!.newContext(),
    guestPage = await guestContext.newPage(),
    viewPage = await guestContext.newPage();
  await guestPage.goto(`${base}/invite/${event.slug}?token=${guest.token}`);
  await guestPage
    .getByLabel("Photo (JPEG, PNG or WebP, up to 10 MB)", { exact: true })
    .setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGXsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await guestPage
    .getByLabel("Photo caption", { exact: true })
    .fill("Our shared celebration");
  await guestPage
    .getByLabel("I have permission to upload this photo", { exact: false })
    .check();
  await guestPage
    .getByRole("button", { name: "Submit photo for review" })
    .click();
  await expect(
    guestPage.getByText("Photo submitted for organizer review.", {
      exact: false,
    }),
  ).toBeVisible();
  await viewPage.goto(`${base}/invite/${event.slug}?token=${other.token}`);
  await expect(viewPage.getByAltText("Our shared celebration")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText("Memory approved", { exact: true }),
  ).toBeVisible();
  await viewPage.getByRole("button", { name: "Refresh photos" }).click();
  await expect(viewPage.getByAltText("Our shared celebration")).toBeVisible();
  guestPage.on("dialog", (dialog) => dialog.accept());
  await guestPage.getByRole("button", { name: "Withdraw photo" }).click();
  await expect(
    guestPage.getByText("Photo withdrawn.", { exact: false }),
  ).toBeVisible();
  await viewPage.getByRole("button", { name: "Refresh photos" }).click();
  await expect(viewPage.getByAltText("Our shared celebration")).toHaveCount(0);
  await guestContext.close();
});

test("internal navigation asks before discarding unsaved invitation edits", async ({
  page,
}) => {
  await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Editor",
      email: `editor-${crypto.randomUUID()}@example.com`,
      password: "Editor-Password-2026!",
    },
  });
  await page.request.post("/api/v1/events", {
    data: {
      title: "Unsaved edit test",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "Africa/Lagos",
      location: "Lagos",
    },
  });
  await page.goto("/app");
  await page.getByRole("button", { name: "Experience", exact: true }).click();
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByLabel("Section heading").fill("Keep my edits");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Section heading")).toHaveValue("Keep my edits");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Event settings", exact: true }),
  ).toBeVisible();
});

test("organizer sees enforced free limits, disabled draft packages and payout onboarding", async ({
  page,
}) => {
  const registered = await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Package Organizer",
      email: `packages-${crypto.randomUUID()}@example.com`,
      password: "Browser-Test-2026!",
    },
  });
  expect(registered.status()).toBe(201);
  const created = await page.request.post("/api/v1/events", {
    data: {
      title: "Package test event",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "Africa/Lagos",
      location: "Lagos",
    },
  });
  const event = (await created.json()).event;
  expect(
    (
      await page.request.post(`/api/v1/events/${event.id}/guests`, {
        data: { name: "Family A", party: 30 },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await page.request.post(`/api/v1/events/${event.id}/guests`, {
        data: { name: "Family B", party: 21 },
      })
    ).status(),
  ).toBe(409);
  await page.goto("/app");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Packages & usage" }),
  ).toBeVisible();
  await expect(
    page.getByText("Current package: free", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("30 / 50", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buy Essential", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("No package purchases yet.", { exact: true }),
  ).toBeVisible();
  await page.goto("/app/account");
  await expect(
    page.getByRole("heading", { name: "Organizer payout account" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit for payout review" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Load supported Nigerian banks" })
    .click();
  await expect(
    page.getByText("Paystack is not configured", { exact: true }),
  ).toBeVisible();
  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", { name: "Essential", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("DRAFT · NOT ON SALE", { exact: true }),
  ).toHaveCount(6);
});

test("checkout return does not grant a package and recovery UI waits for server verification", async ({
  page,
}) => {
  await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Billing Return",
      email: `billing-${crypto.randomUUID()}@example.com`,
      password: "Browser-Test-2026!",
    },
  });
  const created = await page.request.post("/api/v1/events", {
    data: {
      title: "Billing return fixture",
      eventType: "custom",
      date: "2027-06-16",
      timezone: "Africa/Lagos",
      location: "Lagos",
    },
  });
  const event = (await created.json()).event;
  const bill = await (
    await page.request.get(`/api/v1/events/${event.id}/billing`)
  ).json();
  let verified = false,
    initializeRequests = 0;
  // Browser-only provider fixture. Database tests separately validate signed settlement and exactly-once grants.
  await page.route(`**/api/v1/events/${event.id}/billing**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/reconcile")) {
      verified = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path.endsWith("/checkout")) {
      initializeRequests++;
      await route.fulfill({ status: 500, json: {} });
      return;
    }
    await route.fulfill({
      json: {
        ...bill,
        entitlement: {
          ...bill.entitlement,
          ...(verified
            ? { plan_code: "essential", tier: 1, guest_limit: 200 }
            : {}),
        },
        orders: [
          {
            reference: "bill_browser_fixture",
            request_key: "browser-fixture-stable-key",
            product_code: "essential",
            amount_minor: 750000,
            status: verified ? "paid" : "uncertain",
            paid_at: verified ? "2026-09-27 12:00:00" : null,
          },
        ],
      },
    });
  });
  await page.goto(`/app?billing=bill_browser_fixture&billingEvent=${event.id}`);
  await expect(
    page.getByRole("heading", { name: "Package payment status" }),
  ).toBeVisible();
  await expect(
    page.getByText("Current package: free", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue existing checkout" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check payment", exact: true })
    .click();
  await expect(
    page.getByText("Current package: essential", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0 / 200", { exact: true })).toBeVisible();
  expect(initializeRequests).toBe(0);
});

test("commerce operator UI submits explicit catalog approval and identity review with cleared step-up credentials", async ({
  page,
}) => {
  await page.request.post("/api/v1/auth/register", {
    data: {
      name: "Operator UI fixture",
      email: `operator-ui-${crypto.randomUUID()}@example.com`,
      password: "Browser-Test-2026!",
    },
  });
  // UI-only administrator fixture. Role, password and MFA enforcement are covered against the real Worker in database tests.
  let updated: any = null,
    approved: any = null;
  await page.route("**/api/v1/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/commerce")) {
      await route.fulfill({
        json: {
          accounts: [
            {
              user_id: "review-owner",
              email: "organizer@example.com",
              bank_name: "Test Bank",
              account_name: "Test Organizer",
              last_four: "6789",
              state: approved ? "verified" : "review",
              subaccount_code: "ACCT_review",
            },
          ],
          orders: [],
        },
      });
      return;
    }
    if (path.includes("/plans/")) updated = route.request().postDataJSON();
    if (path.endsWith("/verify")) approved = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/app/commerce");
  await expect(
    page.getByRole("heading", { name: "Commerce operations" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Package", exact: true }).selectOption("essential");
  await page.getByLabel("Price (NGN)", { exact: true }).fill("8000");
  await page
    .getByLabel("Password for financial changes", { exact: true })
    .fill("Browser-Test-2026!");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save catalog entry" }).click();
  await expect.poll(() => updated?.priceMinor).toBe(800000);
  await expect(
    page.getByLabel("Password for financial changes", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Verify & approve" }),
  ).toBeDisabled();
  await page
    .getByLabel("Review reason (at least 10 characters)", { exact: true })
    .fill("Identity and receiving authority reviewed by operator");
  await page
    .getByLabel("Password for financial changes", { exact: true })
    .fill("Browser-Test-2026!");
  await page
    .getByLabel(
      "I have independently reviewed identity and authority to receive these contributions.",
    )
    .check();
  await page.getByRole("button", { name: "Verify & approve" }).click();
  await expect.poll(() => approved?.identityReviewed).toBe(true);
  expect(approved.subaccountCode).toBe("ACCT_review");
  await expect(
    page.getByLabel("Password for financial changes", { exact: true }),
  ).toHaveValue("");
});
