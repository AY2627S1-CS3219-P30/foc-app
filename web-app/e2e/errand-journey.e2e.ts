import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ORDER, ORDER_URL, errandEmail, firstSupplier, signIn, visible } from "./request-helpers";

/**
 * WEB-02, WEB-03 and WEB-05 end to end, once per breakpoint, against the real stack: two couriers race
 * to accept one errand. One wins and the other's stale card is replaced. The winner sees the delivery
 * instructions, records pickup and delivery, and the requester confirms receipt, then follows the
 * receipt to the payment in their wallet and back.
 */

const INSTRUCTIONS = "Leave it at the lobby counter.";

test("errand journey: a lost acceptance race, fulfilment, and the requester confirming", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const stamp = `${testInfo.project.name}-${Date.now()}`;
  const token = await signIn(page.request, errandEmail("requester"));
  const winner = await student(browser, page, errandEmail("winner"));
  const loser = await student(browser, page, errandEmail("loser"));
  const supplier = await firstSupplier(request, token);
  const item = `Race ${stamp}`;
  const auth = { authorization: `Bearer ${token}` };

  const created = await request.post(`${ORDER}/orders`, {
    headers: { ...auth, "idempotency-key": randomUUID() },
    data: {
      supplierId: supplier.supplierId,
      items: [{ name: item, quantity: 1 }],
      deliveryZone: "PGP House 7",
      deliveryInstructions: INSTRUCTIONS,
      reward: 1,
    },
  });
  expect(created.status()).toBe(201);
  const { orderId } = await created.json();
  await expect
    .poll(async () => (await (await request.get(`${ORDER}/orders/${orderId}`, { headers: auth })).json()).status, {
      timeout: 30_000,
    })
    .toBe("OPEN");

  await test.step("the requester's own errand is not in their feed", async () => {
    await page.goto("/feed");
    await expect(visible(page, "Loading open errands…")).toHaveCount(0);
    await expect(card(page, item)).toHaveCount(0);
  });

  await test.step("both couriers see the card; the second to confirm loses and its card goes", async () => {
    for (const courier of [winner, loser]) {
      await courier.goto("/feed");
      await card(courier, item).getByRole("button", { name: "Accept" }).click();
      await expect(courier.getByRole("dialog")).toContainText("Accept this errand?");
    }
    await winner.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
    await expect(winner).toHaveURL(ORDER_URL);

    await loser.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
    await expect(visible(loser, "Another courier accepted this errand first, or it closed.")).toBeVisible();
    await expect(card(loser, item)).toHaveCount(0);
  });

  await test.step("the winner sees the instructions, then records pickup and delivery", async () => {
    await expect(visible(winner, INSTRUCTIONS)).toBeVisible();
    await act(winner, "I've picked it up", "Record pickup");
    await expect(badge(winner, "In transit")).toBeVisible();
    await act(winner, "Mark as delivered", "Record delivery");
    await expect(badge(winner, "Delivered")).toBeVisible();
  });

  await test.step("the requester confirms receipt and the courier is paid", async () => {
    await page.goto(`/request/${orderId}`);
    await expect(badge(page, "Delivered, confirm receipt")).toBeVisible();
    await act(page, "Confirm receipt", "Confirm receipt");
    await expect(badge(page, "Complete")).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the receipt links to the payment in the wallet, and the payment back to it", async () => {
    const receipt = new RegExp(`/request/${orderId}/receipt$`);
    await page.getByRole("link", { name: "View receipt" }).filter({ visible: true }).click();
    await expect(page).toHaveURL(receipt);
    await expect(visible(page, "Another student").first()).toBeVisible();

    await page.getByRole("link", { name: "See it in your wallet" }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/wallet\?tx=[0-9a-f-]{36}$/);
    const payment = page.locator('[aria-current="true"]');
    await expect(payment).toBeFocused();
    await expect(payment).toContainText("Paid your courier");
    await expect(payment).toContainText("-1");

    await payment.getByRole("link", { name: "Paid your courier" }).click();
    await expect(page).toHaveURL(receipt);
  });

  await test.step("the courier's wallet shows what they earned", async () => {
    await winner.goto("/wallet");
    await expect(visible(winner, "Earned for a delivery").first()).toBeVisible();
  });

  await Promise.all([winner, loser].map((courier) => courier.context().close()));
});

/** Another signed-in student, in a browser context of their own at the same width. */
async function student(browser: Browser, like: Page, email: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: like.viewportSize(),
  });
  await signIn(context.request, email);
  return context.newPage();
}

const badge = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).filter({ visible: true });

const card = (page: Page, item: string) => page.locator(".card", { hasText: item }).filter({ visible: true });

/** Clicks an action on the errand page, then confirms it in the dialog. */
async function act(page: Page, label: string, confirm: string) {
  await page.getByRole("button", { name: label }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
