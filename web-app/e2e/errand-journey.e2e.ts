import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ORDER, ORDER_URL, activeStudent, firstSupplier, signIn, visible } from "./stack";

/**
 * WEB-02 and WEB-05 end to end, once per breakpoint, against the real stack: two couriers race to
 * accept one errand. One wins and the other's stale card is replaced. The winner sees the delivery
 * instructions, records pickup and delivery, and the requester confirms receipt.
 */

const INSTRUCTIONS = "Leave it at the lobby counter.";

test("errand journey: a lost acceptance race, fulfilment, and the requester confirming", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const stamp = `${testInfo.project.name}-${Date.now()}`;
  const email = (who: string) => `e2e-errand-${who}-${stamp}@u.nus.edu`;
  const token = await activeStudent(request, email("requester"));
  await activeStudent(request, email("winner"), "E2E Winner");
  await activeStudent(request, email("loser"), "E2E Loser");
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
      reward: 2,
    },
  });
  expect(created.status()).toBe(201);
  const { orderId } = await created.json();
  await expect
    .poll(async () => (await (await request.get(`${ORDER}/orders/${orderId}`, { headers: auth })).json()).status, {
      timeout: 30_000,
    })
    .toBe("OPEN");

  await signIn(page, email("requester"));
  const winner = await student(browser, page, email("winner"));
  const loser = await student(browser, page, email("loser"));

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
    await expect(badge(winner, "Delivered, confirm receipt")).toBeVisible();
  });

  await test.step("the requester confirms receipt and the courier is paid", async () => {
    await page.goto(`/request/${orderId}`);
    await act(page, "Confirm receipt", "Confirm receipt");
    await expect(badge(page, "Complete")).toBeVisible({ timeout: 30_000 });
  });
});

/** Another signed-in student, in a browser context of their own at the same width. */
async function student(browser: Browser, like: Page, email: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: like.viewportSize(),
  });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
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
