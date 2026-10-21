import { expect, type APIRequestContext, type Page } from "@playwright/test";

const USER = process.env.E2E_USER_SERVICE_URL ?? "http://localhost:3001";
const SUPPLIER = process.env.E2E_SUPPLIER_SERVICE_URL ?? "http://localhost:3002";
export const ORDER = process.env.E2E_ORDER_SERVICE_URL ?? "http://localhost:3003";
const CREDIT = process.env.E2E_CREDIT_SERVICE_URL ?? "http://localhost:3004";
const PASSWORD = "a long enough passphrase";
export const ORDER_URL = /\/request\/[0-9a-f-]{36}(\?.*)?$/;

/** Picks the pickup point, fills one item and the delivery details, and opens the review. */
export async function compose(
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
export const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });

export const row = (page: Page, label: string) =>
  page.locator("div", { has: page.getByText(label, { exact: true }) }).last();

/** Registers and activates through the dev mailbox. Every call counts against the sign-up limit. */
export async function register(request: APIRequestContext, email: string, displayName = "E2E Requester") {
  const registered = await request.post(`${USER}/auth/register`, {
    data: { email, password: PASSWORD, displayName },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const mail = await (await request.get(`${USER}/dev/mailbox`, { params: { to: email } })).json();
  expect((await request.post(`${USER}/auth/activate`, { data: { token: mail.token } })).ok()).toBe(true);
}

/**
 * Signs in and waits for the wallet to be issued. Given a page's `request`, it signs that page in
 * too: they share the refresh cookie, so the page's first load picks up the session.
 */
export async function signIn(request: APIRequestContext, email: string): Promise<string> {
  const login = await request.post(`${USER}/auth/login`, { data: { email, password: PASSWORD } });
  expect(login.ok(), await login.text()).toBe(true);
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

/** A new student, signed in. */
export async function activeStudent(request: APIRequestContext, email: string): Promise<string> {
  await register(request, email);
  return signIn(request, email);
}

/** The errand journey's students, registered once per run by `global-setup.ts`. */
export const ERRAND_STUDENTS = { requester: "E2E Requester", winner: "E2E Winner", loser: "E2E Loser" };

export const errandEmail = (who: keyof typeof ERRAND_STUDENTS) =>
  `e2e-errand-${who}-${process.env.E2E_RUN}@u.nus.edu`;

/** The signed-in student's wallet as the Credit Service reports it. */
export async function wallet(
  request: APIRequestContext,
  token: string,
): Promise<{ available: number; reserved: number }> {
  return (await request.get(`${CREDIT}/wallets/me`, { headers: { authorization: `Bearer ${token}` } })).json();
}

/** The first pickup point the picker lists, since both read the same default order. */
export async function firstSupplier(
  request: APIRequestContext,
  token: string,
): Promise<{ supplierId: string; name: string }> {
  const page = await request.get(`${SUPPLIER}/suppliers`, {
    headers: { authorization: `Bearer ${token}` },
    params: { pageSize: 1 },
  });
  return (await page.json()).items[0];
}
