import { expect, test } from "@playwright/test";
import { adminSession } from "./admin-helpers";
import { ORDER, releaseEmail, signIn, wallet } from "./request-helpers";
import {
  act,
  actor,
  advanceServerClockTo,
  badge,
  extraPage,
  post,
  readOrder,
  reason,
  student,
  waitStatus,
} from "./release-helpers";

test.describe("server deadline journeys @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Requires the explicit isolated release clock override.");
  test.describe.configure({ timeout: 120_000 });

  test("an open errand expires at its server deadline and releases exactly its held reward", async ({
    page,
  }) => {
    let token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const { orderId } = await post(page, token, "controlled expiry");
    expect(await wallet(page.request, token)).toEqual({
      available: before.available - 1,
      reserved: before.reserved + 1,
    });
    const order = await readOrder(page, token, orderId);
    expect(order.acceptanceDeadlineAt).toBeTruthy();
    await advanceServerClockTo(order.acceptanceDeadlineAt);
    token = await signIn(page.request, releaseEmail("requester"));
    await waitStatus(page, token, orderId, "EXPIRED");
    await page.reload();
    await badge(page, "Expired");
    await expect(page.getByRole("button", { name: "Cancel errand", exact: true })).toHaveCount(0);
    await expect.poll(() => wallet(page.request, token)).toEqual(before);
    const response = await page.request.get(`${ORDER}/orders/${orderId}/history`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    const { entries } = await response.json();
    expect(entries.filter((entry: { newStatus: string }) => entry.newStatus === "EXPIRED")).toHaveLength(1);
  });

  test("a delivered errand auto-confirms on the server clock without requester confirmation", async ({
    browser,
    page,
  }) => {
    let token = await signIn(page.request, releaseEmail("requester"));
    const requesterBefore = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    try {
      const courierBefore = await wallet(courier.request, actor(courier).token);
      const { orderId } = await post(page, token, "controlled automatic confirmation");
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await act(courier, "I've picked it up", "Record pickup");
      await act(courier, "Mark as delivered", "Record delivery");
      await page.reload();
      await badge(page, "Delivered, confirm receipt");
      const order = await readOrder(page, token, orderId);
      expect(order.autoConfirmAt).toBeTruthy();
      await advanceServerClockTo(order.autoConfirmAt);
      token = await signIn(page.request, releaseEmail("requester"));
      const courierToken = await signIn(courier.request, releaseEmail("courier"));
      await waitStatus(page, token, orderId, "COMPLETED");
      await page.reload();
      await badge(page, "Complete");
      await expect
        .poll(() => wallet(page.request, token))
        .toEqual({ available: requesterBefore.available - 1, reserved: requesterBefore.reserved });
      await expect
        .poll(() => wallet(courier.request, courierToken))
        .toEqual({ available: courierBefore.available + 1, reserved: courierBefore.reserved });
      const response = await page.request.get(`${ORDER}/orders/${orderId}/history`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status()).toBe(200);
      const { entries } = await response.json();
      expect(entries.filter((entry: { action: string }) => entry.action === "CONFIRM_RECEIPT")).toHaveLength(
        0,
      );
      expect(entries.filter((entry: { newStatus: string }) => entry.newStatus === "COMPLETED")).toHaveLength(
        1,
      );
    } finally {
      await courier.context().close();
    }
  });

  test("non-delivery can be reported only after its server period, then is decided through the console", async ({
    browser,
    page,
  }) => {
    let token = await signIn(page.request, releaseEmail("requester"));
    const before = await wallet(page.request, token);
    const courier = await student(browser, page, "courier");
    const admin = await extraPage(browser, page);
    try {
      let { token: adminToken } = await adminSession(admin);
      const { orderId } = await post(page, token, "controlled non-delivery report");
      await courier.goto(`/request/${orderId}`);
      await act(courier, "Accept errand", "Accept");
      await act(courier, "I've picked it up", "Record pickup");
      await page.reload();
      await badge(page, "In transit");
      await expect(page.getByRole("button", { name: "Report not delivered", exact: true })).toHaveCount(0);
      const order = await readOrder(page, token, orderId);
      expect(order.nonDeliveryReportAt).toBeTruthy();
      await advanceServerClockTo(order.nonDeliveryReportAt);
      token = await signIn(page.request, releaseEmail("requester"));
      await signIn(courier.request, releaseEmail("courier"));
      ({ token: adminToken } = await adminSession(admin));
      await page.reload();
      await act(page, "Report not delivered", "Report");
      await badge(page, "With an administrator");
      await expect
        .poll(
          async () => {
            const response = await admin.request.get(`${ORDER}/admin/orders/referred`, {
              headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(response.status()).toBe(200);
            const { items } = await response.json();
            return items.some(
              (entry: { orderId: string; assignedToMe: boolean }) =>
                entry.orderId === orderId && entry.assignedToMe,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await admin.goto(`/admin/errands/${orderId}`);
      const explanation = "Release rehearsal: the items were not delivered within the delivery period.";
      await reason(admin, "Decide for the requester", "Decide for the requester", explanation);
      await waitStatus(page, token, orderId, "CANCELLED");
      for (const participant of [page, courier]) {
        await participant.reload();
        await badge(participant, "Cancelled");
        await expect(
          participant.getByText(explanation, { exact: true }).filter({ visible: true }),
        ).toBeVisible();
      }
      await expect.poll(() => wallet(page.request, token)).toEqual(before);
    } finally {
      await Promise.all([courier, admin].map((p) => p.context().close()));
    }
  });
});
