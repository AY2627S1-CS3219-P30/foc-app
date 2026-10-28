import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ORDER, ORDER_URL, USER, errandEmail, firstSupplier, signIn, visible } from "./request-helpers";

/**
 * N1.4 (#331) against the real stack: a page hears of a change at once instead of at its next poll,
 * which is every 30 s once an errand is settled. So each "within 3 s" below can only pass through the
 * live-update stream: a new errand reaches a courier's open board, and the courier's accept reaches
 * the requester's open page. Refused a stream, a page says it updates every 30 s, and still works.
 *
 * At 360 px the label is in the phone's app bar, from 768 px in the top bar. It runs at every width,
 * since the release suite allows no skipped test; the errand journey's students sign in once each
 * per width here, six times a run with the errand journey's, inside the User Service's limit of ten
 * per account in 15 minutes.
 */
const LIVE_WITHIN_MS = 3_000;

const liveLabel = (page: Page) =>
  page
    .getByRole("status")
    .filter({ hasText: /^(Live|Reconnecting…|Updating every 30 s)$/ })
    .filter({ visible: true });
const badge = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).filter({ visible: true }).first();
const card = (page: Page, item: string) => page.locator(".card", { hasText: item }).filter({ visible: true });

test("live updates: an errand reaches the open board, and its accept the requester, at once", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const token = await signIn(page.request, errandEmail("requester"));
  const courier = await courierPage(browser, page, errandEmail("loser"));
  const supplier = await firstSupplier(request, token);
  const item = `Live ${testInfo.project.name}-${Date.now()}`;
  const auth = { authorization: `Bearer ${token}` };

  await test.step("refused its stream, a page says it updates every 30 s, and works as before", async () => {
    await page.route("**/api/order/live", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "LIVE_UNAVAILABLE", message: "Live updates are unavailable.", correlationId: "e2e" },
        }),
      }),
    );
    await page.goto("/feed");
    await expect(liveLabel(page)).toHaveText("Updating every 30 s");
    await expect(visible(page, "Active requests").first()).toBeVisible();
    await page.unroute("**/api/order/live");
  });

  await test.step("the courier's open board is live", async () => {
    await courier.goto("/feed");
    await expect(liveLabel(courier)).toHaveText("Live");
  });

  const created = await request.post(`${ORDER}/orders`, {
    headers: { ...auth, "idempotency-key": randomUUID() },
    data: {
      supplierId: supplier.supplierId,
      items: [{ name: item, quantity: 1 }],
      deliveryZone: "PGP House 7",
      deliveryInstructions: "Leave it at the lobby counter.",
      reward: 1,
    },
  });
  expect(created.status()).toBe(201);
  const { orderId } = await created.json();
  const read = async (): Promise<{ status: string; version: number }> =>
    (await request.get(`${ORDER}/orders/${orderId}`, { headers: auth })).json();

  await test.step("the new errand appears on the courier's board within 3 s of opening, unreloaded", async () => {
    await expect.poll(async () => (await read()).status, { timeout: 30_000, intervals: [200] }).toBe("OPEN");
    await expect(card(courier, item)).toBeVisible({ timeout: LIVE_WITHIN_MS });
  });

  await test.step("the requester's open page says Accepted within 3 s of the courier accepting", async () => {
    await page.goto(`/request/${orderId}`);
    await expect(liveLabel(page)).toHaveText("Live");
    await expect(badge(page, "Open")).toBeVisible();

    await card(courier, item).getByRole("button", { name: "Accept" }).click();
    await courier.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
    await expect(courier).toHaveURL(ORDER_URL);
    await expect(badge(page, "Accepted")).toBeVisible({ timeout: LIVE_WITHIN_MS });
  });

  // The requester's credit back, so the shared accounts last the run.
  const cancelled = await request.post(`${ORDER}/orders/${orderId}/cancel`, {
    headers: auth,
    data: { expectedVersion: (await read()).version },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  await courier.context().close();
});

/** A signed-in courier, in a browser context of their own at the same width. */
async function courierPage(browser: Browser, like: Page, email: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: like.viewportSize(),
  });
  const token = await signIn(context.request, email);
  const mode = await context.request.patch(`${USER}/users/me`, {
    headers: { authorization: `Bearer ${token}` },
    data: { preferredMode: "COURIER" },
  });
  expect(mode.ok(), await mode.text()).toBe(true);
  return context.newPage();
}
