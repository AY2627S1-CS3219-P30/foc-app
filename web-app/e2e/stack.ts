import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** The running stack the journeys drive. Nothing is mocked. */
export const USER = process.env.E2E_USER_SERVICE_URL ?? "http://localhost:3001";
export const SUPPLIER = process.env.E2E_SUPPLIER_SERVICE_URL ?? "http://localhost:3002";
export const ORDER = process.env.E2E_ORDER_SERVICE_URL ?? "http://localhost:3003";
export const CREDIT = process.env.E2E_CREDIT_SERVICE_URL ?? "http://localhost:3004";
export const PASSWORD = "a long enough passphrase";
export const ORDER_URL = /\/request\/[0-9a-f-]{36}$/;

/** Screens render a phone and a desktop tree; CSS shows one. */
export const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });

/**
 * Registers (unless already registered), activates through the dev mailbox and signs in; waits for
 * the wallet to be issued. Given a page's `request`, it signs that page in too: they share the
 * refresh cookie, so the page's first load picks up the session without a second login.
 */
export async function activeStudent(
  request: APIRequestContext,
  email: string,
  displayName = "E2E Requester",
): Promise<string> {
  const registered = await request.post(`${USER}/auth/register`, {
    data: { email, password: PASSWORD, displayName },
  });
  expect(registered.ok() || registered.status() === 409, await registered.text()).toBe(true);
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
