import { test, expect } from "@playwright/test";

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
    data: { email, password },
  });
  expect(oldLogin.status()).toBe(401);
  const newLogin = await page.request.post("/api/v1/auth/login", {
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
