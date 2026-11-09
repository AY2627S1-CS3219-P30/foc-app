import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  activeStudent,
  compose,
  firstSupplier,
  ORDER,
  ORDER_URL,
  row,
  visible,
  wallet as readWallet,
} from "./request-helpers";

/**
 * WEB-01 end to end, once per breakpoint, against the real stack (nothing mocked):
 * - a submitted request is `PENDING_CREDIT`, then opens, and the Credit Service reserves exactly
 *   the reward the review projected;
 * - once the wallet can no longer cover the reward, the review step blocks the post and says why;
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
  const token = await activeStudent(page.request, email);
  const supplier = await firstSupplier(request, token);
  const auth = { authorization: `Bearer ${token}` };
  const wallet = () => readWallet(request, token);

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

  await test.step("a reward the wallet no longer covers is blocked, and one Credit refuses says why", async () => {
    await compose(page, { supplier: supplier.name, item: "Kaya toast", reward: 5 });
    await expect(row(page, "Available after reserving the reward")).toContainText("0 credits");

    const post = (name: string) =>
      request.post(`${ORDER}/orders`, {
        headers: { ...auth, "idempotency-key": randomUUID() },
        data: {
          supplierId: supplier.supplierId,
          items: [{ name, quantity: 1 }],
          deliveryZone: "PGP",
          deliveryInstructions: "Lobby",
          reward: 5,
        },
      });

    // Another errand takes the last 5 credits through the API. The review step reads the shared
    // balance, which refreshes on that errand's live nudge or within 30 s, so it then blocks the post
    // rather than send one the Credit Service would refuse. Before, this step clicked "Post request"
    // and raced that refresh.
    expect((await post("Drained elsewhere")).status()).toBe(201);
    await expect.poll(async () => (await wallet()).available, { timeout: 30_000 }).toBe(0);
    await expect(
      visible(page, "You have no credits available, so you can't post a request yet."),
    ).toBeVisible({ timeout: 35_000 });
    await expect(page.getByRole("button", { name: "Post request" })).toBeDisabled();

    // A request that reaches the Credit Service anyway, as one sent before the balance refreshed
    // would, is rejected, and its page says why with the balance the Credit Service reported.
    const refused = await post("Kaya toast");
    expect(refused.status()).toBe(201);
    await page.goto(`/request/${(await refused.json()).orderId}`);
    await expect(page).toHaveURL(ORDER_URL);
    await expect(visible(page, "Not placed")).toBeVisible({ timeout: 30_000 });
    await expect(
      visible(page, "You had 0 available for a 5-credit reward. Delivering errands as a courier"),
    ).toBeVisible();
  });
});
