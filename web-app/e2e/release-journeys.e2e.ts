import { expect, test, type Browser, type Page } from "@playwright/test";
import { adminSession } from "./admin-helpers";
import { compose, firstSupplier, ORDER, ORDER_URL, releaseEmail, signIn, USER, wallet } from "./request-helpers";

test.describe("release journeys @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack with E2E_RELEASE=1.");
  test.setTimeout(120_000);

  test("composer, withdrawal, cancellation and both participants' history", async ({ browser, page }) => {
    const token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    try {
      const { orderId, item } = await post(page, token, "withdraw and cancel");
      await expect.poll(() => wallet(page.request, token)).toMatchObject({ available: before.available - 1, reserved: before.reserved + 1 });
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await act(courier, "Withdraw", "Withdraw");
      await expect(courier).toHaveURL(/\/feed(?:\?withdrawn=1)?$/);
      await page.reload();
      await badge(page, "Open");
      // Withdrawal keeps the same reservation for the next courier; it does not release or pay.
      expect(await wallet(page.request, token)).toMatchObject({ available: before.available - 1, reserved: before.reserved + 1 });
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await page.reload();
      await badge(page, "Accepted");
      await act(page, "Cancel errand", "Cancel errand");
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
      await page.goto("/order-history");
      await expect(page.locator(".card", { hasText: item }).filter({ visible: true })).toContainText("Cancelled");
      await courier.goto("/order-history");
      await expect(courier.locator(".card", { hasText: item }).filter({ visible: true })).toContainText("Cancelled");

      await post(page, token, "cancel before acceptance");
      await act(page, "Cancel errand", "Cancel errand");
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
    } finally { await courier.context().close(); }
  });

  test("a reported delivery is referred, decided in the console, and shown to the student", async ({ browser, page }) => {
    const token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    const admin = await extraPage(browser, page);
    try {
      const { token: adminToken } = await adminSession(admin);
      const { orderId } = await post(page, token, "disputed delivery");
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await act(courier, "I've picked it up", "Record pickup");
      await act(courier, "Mark as delivered", "Record delivery");
      await page.reload();
      await badge(page, "Delivered, confirm receipt");
      await act(page, "I didn't receive it", "Report");
      await badge(page, "With an administrator");
      await expect.poll(async () => {
        const referred = await admin.request.get(`${ORDER}/admin/orders/referred`, { headers: { authorization: `Bearer ${adminToken}` } });
        expect(referred.status()).toBe(200);
        const { items } = await referred.json();
        return items.some((order: { orderId: string; assignedToMe: boolean }) => order.orderId === orderId && order.assignedToMe);
      }, { timeout: 30_000 }).toBe(true);
      await admin.goto(`/admin/errands/${orderId}`);
      await admin.getByRole("button", { name: "Decide for the requester", exact: true }).click();
      await admin.getByRole("dialog").getByRole("textbox", { name: "Reason" }).fill("Release rehearsal: delivery was not received.");
      await admin.getByRole("dialog").getByRole("button", { name: "Decide for the requester", exact: true }).click();
      await expect(admin.getByRole("dialog")).toBeHidden();
      await page.reload();
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
      await expect(page.getByText(/administrator|decision/i).filter({ visible: true }).first()).toBeVisible();
    } finally { await Promise.all([courier, admin].map((p) => p.context().close())); }
  });

  test("supplier search and filters read the real catalogue", async ({ page }) => {
    await signIn(page.request, releaseEmail("requester"));
    await page.goto("/suppliers");
    await page.getByRole("searchbox", { name: "Search suppliers" }).fill("Printer @ Com 2");
    await expect(page.getByRole("heading", { name: "Printer @ Com 2", exact: true })).toBeVisible();
    const filters = page.getByRole("button", { name: "Filters and sort" });
    if (await filters.isVisible()) await filters.click();
    await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("PRINTING");
    await expect(page.getByRole("heading", { name: "Printer @ Com 2", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("FOOD");
    await expect(page.getByRole("heading", { name: "Printer @ Com 2", exact: true })).toHaveCount(0);
  });

  test("an administrator signs in and opens every console area", async ({ page }) => {
    await adminSession(page, true);
    for (const [path, title] of [
      ["/admin", "Overview"], ["/admin/users", "Users"], ["/admin/role-requests", "Role requests"],
      ["/admin/audit", "Audit trail"], ["/admin/activity", "Admin activity"], ["/admin/errands", "Errands"],
      ["/suppliers", "Suppliers"], ["/admin/wallets", "Wallets"], ["/admin/operations", "Operations"],
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, exact: true }).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
  });
});

async function extraPage(browser: Browser, like: Page) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: like.viewportSize() });
  return context.newPage();
}

async function student(browser: Browser, like: Page, who: "courier" | "replacement") {
  const page = await extraPage(browser, like);
  const token = await signIn(page.request, releaseEmail(who));
  const mode = await page.request.patch(`${USER}/users/me`, { headers: { authorization: `Bearer ${token}` }, data: { preferredMode: "COURIER" } });
  expect(mode.status()).toBe(200);
  return page;
}

async function post(page: Page, token: string, label: string) {
  const supplier = await firstSupplier(page.request, token);
  const item = `${label} ${test.info().project.name} ${Date.now()}`;
  await compose(page, { supplier: supplier.name, item, reward: 1 });
  const response = page.waitForResponse((r) => r.url() === `${ORDER}/orders` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Post request" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const { orderId } = await created.json();
  await expect(page).toHaveURL(ORDER_URL);
  await badge(page, "Open");
  return { orderId: orderId as string, item };
}

async function act(page: Page, label: string, confirm: string) {
  await page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function badge(page: Page, label: string) {
  await expect(page.getByText(label, { exact: true }).filter({ visible: true })).toBeVisible({ timeout: 30_000 });
}
