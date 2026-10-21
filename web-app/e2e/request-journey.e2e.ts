import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * WEB-01 end to end, once per breakpoint, against the real stack (nothing mocked):
 * - a submitted request is `PENDING_CREDIT`, then opens, and the Credit Service reserves exactly
 *   the reward the review projected;
 * - a request the wallet can no longer cover when it reaches the Credit Service is rejected, and the
 *   page says why with the balance it reported.
 *
 * A new student starts with 10 credits. The second request is reviewed with 5 available; another
 * errand then takes those 5 through the API, so the reservation fails as INSUFFICIENT_CREDITS.
 */

const USER = process.env.E2E_USER_SERVICE_URL ?? "http://localhost:3001";
const SUPPLIER = process.env.E2E_SUPPLIER_SERVICE_URL ?? "http://localhost:3002";
const ORDER = process.env.E2E_ORDER_SERVICE_URL ?? "http://localhost:3003";
const CREDIT = process.env.E2E_CREDIT_SERVICE_URL ?? "http://localhost:3004";
const PASSWORD = "a long enough passphrase";
const ORDER_URL = /\/request\/[0-9a-f-]{36}$/;

test("request journey: post, wait for credits, open; then an insufficient-credit rejection", async ({
  page,
  request,
}, testInfo) => {
  const email = `e2e-request-${testInfo.project.name}-${Date.now()}@u.nus.edu`;
  const token = await activeStudent(request, email);
  const supplier = await firstSupplier(request, token);
  const auth = { authorization: `Bearer ${token}` };
  const wallet = async () =>
    (await (await request.get(`${CREDIT}/wallets/me`, { headers: auth })).json()) as {
      available: number;
      reserved: number;
    };

  await test.step("sign in", async () => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await page.getByRole("textbox", { name: "NUS email", exact: true }).fill(email);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/feed$/);
  });

  await test.step("post: PENDING_CREDIT, then open, with exactly the reward reserved", async () => {
    await compose(page, { supplier: supplier.name, item: "Kopi O", reward: 5 });
    await expect(
      page.getByText("Open for a set time once your credits are reserved; the request shows the deadline"),
    ).toBeVisible();
    await expect(row(page, "Available balance")).toContainText("10 credits");
    await expect(row(page, "Available after reserving the reward")).toContainText("5 credits");

    const created = page.waitForResponse(
      (r) => r.url() === `${ORDER}/orders` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Post request" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect((await response.json()).status).toBe("PENDING_CREDIT");

    await expect(page).toHaveURL(ORDER_URL);
    await expect(visible(page, /^Open until /)).toBeVisible({ timeout: 30_000 });
    expect(await wallet()).toMatchObject({ available: 5, reserved: 5 });
  });

  await test.step("a reward the wallet no longer covers is rejected with the reason", async () => {
    await compose(page, { supplier: supplier.name, item: "Kaya toast", reward: 5 });
    await expect(row(page, "Available after reserving the reward")).toContainText("0 credits");

    const other = await request.post(`${ORDER}/orders`, {
      headers: { ...auth, "idempotency-key": randomUUID() },
      data: {
        supplierId: supplier.supplierId,
        items: [{ name: "Drained elsewhere", quantity: 1 }],
        deliveryZone: "PGP",
        deliveryInstructions: "Lobby",
        reward: 5,
      },
    });
    expect(other.status()).toBe(201);
    await expect.poll(async () => (await wallet()).available, { timeout: 30_000 }).toBe(0);

    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page).toHaveURL(ORDER_URL);
    await expect(visible(page, "Not placed")).toBeVisible({ timeout: 30_000 });
    await expect(
      visible(page, "You had 0 available for a 5-credit reward. Delivering errands as a courier"),
    ).toBeVisible();
  });
});

/** Picks the pickup point, fills one item and the delivery details, and opens the review. */
async function compose(
  page: Page,
  { supplier, item, reward }: { supplier: string; item: string; reward: number },
) {
  await page.goto("/request/new");
  await page.getByRole("button", { name: supplier }).click();
  await expect(page).toHaveURL(/\/request\/new\/details\?supplierId=/);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(item);
  await page.getByRole("textbox", { name: "Delivery zone" }).fill("PGP House 7");
  await page.getByRole("textbox", { name: "Delivery instructions" }).fill("Leave it at the lobby counter.");
  await page.getByRole("slider").fill(String(reward));
  await page.getByRole("button", { name: "Review request" }).click();
  await expect(page).toHaveURL(/\/request\/new\/review\?supplierId=/);
}

/** The order page renders a phone and a desktop tree; CSS shows one. */
const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });

const row = (page: Page, label: string) =>
  page.locator("div", { has: page.getByText(label, { exact: true }) }).last();

/** Registers, activates through the dev mailbox and signs in; waits for the wallet to be issued. */
async function activeStudent(request: APIRequestContext, email: string): Promise<string> {
  const registered = await request.post(`${USER}/auth/register`, {
    data: { email, password: PASSWORD, displayName: "E2E Requester" },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const mail = await (await request.get(`${USER}/dev/mailbox`, { params: { to: email } })).json();
  expect((await request.post(`${USER}/auth/activate`, { data: { token: mail.token } })).ok()).toBe(true);
  const login = await request.post(`${USER}/auth/login`, { data: { email, password: PASSWORD } });
  const { accessToken } = await login.json();
  await expect
    .poll(
      async () =>
        (await request.get(`${CREDIT}/wallets/me`, { headers: { authorization: `Bearer ${accessToken}` } }))
          .status(),
      { timeout: 30_000 },
    )
    .toBe(200);
  return accessToken;
}

/** The first pickup point the picker lists, since both read the same default order. */
async function firstSupplier(
  request: APIRequestContext,
  token: string,
): Promise<{ supplierId: string; name: string }> {
  const page = await request.get(`${SUPPLIER}/suppliers`, {
    headers: { authorization: `Bearer ${token}` },
    params: { pageSize: 1 },
  });
  return (await page.json()).items[0];
}
