import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { CREDIT, ORDER, ORDER_URL, activeStudent, firstSupplier, signIn, visible } from "./stack";

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

  await test.step("sign in", () => signIn(page, email));

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

const row = (page: Page, label: string) =>
  page.locator("div", { has: page.getByText(label, { exact: true }) }).last();
