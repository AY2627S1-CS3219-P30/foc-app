import { expect, test } from "@playwright/test";
import { adminSession } from "./admin-helpers";
import { ORDER, releaseEmail, signIn, wallet } from "./request-helpers";
import { act, actor, badge, extraPage, post, reason, student, waitStatus } from "./release-helpers";

test.describe("release journeys @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack with E2E_RELEASE=1.");
  test.describe.configure({ timeout: 120_000 });

  test("composer, withdrawal, cancellation and both participants' history", async ({ browser, page }) => {
    const token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    try {
      const { orderId, item } = await post(page, token, "withdraw and cancel");
      await expect
        .poll(() => wallet(page.request, token))
        .toMatchObject({ available: before.available - 1, reserved: before.reserved + 1 });
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await act(courier, "Withdraw", "Withdraw");
      await expect(courier).toHaveURL(/\/feed(?:\?withdrawn=1)?$/);
      await page.reload();
      await badge(page, "Open");
      // Withdrawal keeps the same reservation for the next courier; it does not release or pay.
      expect(await wallet(page.request, token)).toMatchObject({
        available: before.available - 1,
        reserved: before.reserved + 1,
      });
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await page.reload();
      await badge(page, "Accepted");
      await act(page, "Cancel errand", "Cancel errand");
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
      await page.goto("/order-history");
      await expect(page.locator(".card", { hasText: item }).filter({ visible: true })).toContainText(
        "Cancelled",
      );
      await courier.goto("/order-history");
      await expect(courier.locator(".card", { hasText: item }).filter({ visible: true })).toContainText(
        "Cancelled",
      );

      await post(page, token, "cancel before acceptance");
      await act(page, "Cancel errand", "Cancel errand");
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
    } finally {
      await courier.context().close();
    }
  });

  test("a reported delivery is referred, decided in the console, and shown to the student", async ({
    browser,
    page,
  }) => {
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
      await expect
        .poll(
          async () => {
            const referred = await admin.request.get(`${ORDER}/admin/orders/referred`, {
              headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(referred.status()).toBe(200);
            const { items } = await referred.json();
            return items.some(
              (order: { orderId: string; assignedToMe: boolean }) =>
                order.orderId === orderId && order.assignedToMe,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await admin.goto(`/admin/errands/${orderId}`);
      await admin.getByRole("button", { name: "Decide for the requester", exact: true }).click();
      await admin
        .getByRole("dialog")
        .getByRole("textbox", { name: "Reason" })
        .fill("Release rehearsal: delivery was not received.");
      await admin
        .getByRole("dialog")
        .getByRole("button", { name: "Decide for the requester", exact: true })
        .click();
      await expect(admin.getByRole("dialog")).toBeHidden();
      await page.reload();
      await badge(page, "Cancelled");
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
      await expect(
        page
          .getByText(/administrator|decision/i)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    } finally {
      await Promise.all([courier, admin].map((p) => p.context().close()));
    }
  });

  test("suspending an accepted courier reopens the errand for a replacement and pays only that replacement", async ({
    browser,
    page,
  }) => {
    const token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    const replacement = await student(browser, page, "replacement");
    const admin = await extraPage(browser, page);
    try {
      await adminSession(admin);
      const courierBefore = await wallet(courier.request, actor(courier).token);
      const replacementBefore = await wallet(replacement.request, actor(replacement).token);
      const { orderId } = await post(page, token, "suspended courier reassignment");
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await admin.goto(`/admin/users/${actor(courier).id}`);
      await reason(admin, "Suspend", "Suspend account", "Release rehearsal: courier is unavailable.");
      await expect(admin.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
      await waitStatus(page, token, orderId, "OPEN");
      expect(await wallet(page.request, token)).toEqual({
        available: before.available - 1,
        reserved: before.reserved + 1,
      });
      await replacement.goto(`/request/${orderId}`);
      await act(replacement, "Accept errand", "Accept");
      await act(replacement, "I've picked it up", "Record pickup");
      await act(replacement, "Mark as delivered", "Record delivery");
      await page.reload();
      await badge(page, "Delivered, confirm receipt");
      await act(page, "Confirm receipt", "Confirm receipt");
      await badge(page, "Complete");
      await expect
        .poll(() => wallet(page.request, token))
        .toEqual({ available: before.available - 1, reserved: before.reserved });
      await expect
        .poll(() => wallet(replacement.request, actor(replacement).token))
        .toEqual({ available: replacementBefore.available + 1, reserved: replacementBefore.reserved });
      // Reactivation is an ordinary audited UI action; later widths must not inherit a suspended actor.
      await reason(
        admin,
        "Reactivate",
        "Reactivate account",
        "Release rehearsal completed; restore test courier.",
      );
      await expect(admin.getByRole("button", { name: "Suspend", exact: true })).toBeVisible();
      const restored = await signIn(courier.request, releaseEmail("courier"));
      expect(await wallet(courier.request, restored)).toEqual(courierBefore);
    } finally {
      await Promise.all([courier, replacement, admin].map((p) => p.context().close()));
    }
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
      ["/admin", "Overview"],
      ["/admin/users", "Users"],
      ["/admin/role-requests", "Role requests"],
      ["/admin/audit", "Audit trail"],
      ["/admin/activity", "Admin activity"],
      ["/admin/errands", "Errands"],
      ["/suppliers", "Suppliers"],
      ["/admin/wallets", "Wallets"],
      ["/admin/operations", "Operations"],
    ]) {
      await page.goto(path);
      if (path === "/suppliers")
        await expect(page.getByRole("searchbox", { name: "Search suppliers" })).toBeVisible();
      else
        await expect(
          page.getByRole("heading", { name: title, exact: true }).filter({ visible: true }).first(),
        ).toBeVisible();
      // The route announcer and Mode control keep empty live regions mounted.
      await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
    }
  });
});
