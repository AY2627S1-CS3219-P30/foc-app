import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { adminSession } from "./admin-helpers";
import { errandEmail, firstSupplier, ORDER, signIn, USER, wallet } from "./request-helpers";

test("participants read both dispute outcomes and reasons; an outsider cannot read the history", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const requesterToken = await signIn(page.request, errandEmail("requester"));
  const contexts = await Promise.all(
    ["winner", "loser"].map(async (who) => {
      const context = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
        viewport: page.viewportSize(),
      });
      const token = await signIn(context.request, errandEmail(who as "winner" | "loser"));
      return { context, token, page: await context.newPage() };
    }),
  );
  const [courier, outsider] = contexts;
  const adminContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: page.viewportSize(),
  });
  const admin = await adminContext.newPage();
  try {
    const { token: adminToken } = await adminSession(admin);
    const mode = await courier.context.request.patch(`${USER}/users/me`, {
      headers: { authorization: `Bearer ${courier.token}` },
      data: { preferredMode: "COURIER" },
    });
    expect(mode.status()).toBe(200);
    const supplier = await firstSupplier(page.request, requesterToken);
    const funds = async (actor: { request: Page["request"]; token: string }) => {
      const { available, reserved } = await wallet(actor.request, actor.token);
      return { available, reserved };
    };
    for (const outcome of ["REQUESTER", "COURIER"] as const) {
      const requesterBefore = await funds({ request: page.request, token: requesterToken });
      const courierBefore = await funds({ request: courier.page.request, token: courier.token });
      const created = await page.request.post(`${ORDER}/orders`, {
        headers: { authorization: `Bearer ${requesterToken}`, "idempotency-key": randomUUID() },
        data: {
          supplierId: supplier.supplierId,
          items: [{ name: `Dispute ${outcome}`, quantity: 1 }],
          deliveryZone: "PGP House 7",
          deliveryInstructions: "Lobby counter",
          reward: 1,
        },
      });
      expect(created.status()).toBe(201);
      const { orderId } = await created.json();
      const orderUrl = `/request/${orderId}`;
      await page.goto(orderUrl);
      await expect(status(page, "Open")).toBeVisible({ timeout: 30_000 });
      await courier.page.goto(orderUrl);
      await act(courier.page, "Accept errand", "Accept");
      await act(courier.page, "I've picked it up", "Record pickup");
      await act(courier.page, "Mark as delivered", "Record delivery");
      await page.reload();
      await expect(status(page, "Delivered, confirm receipt")).toBeVisible();
      await act(page, "I didn't receive it", "Report");
      await expect(status(page, "With an administrator")).toBeVisible();
      await expect(status(page, "There's nothing for you to do while they decide.")).toBeVisible();
      await expect
        .poll(
          async () => {
            const response = await admin.request.get(`${ORDER}/admin/orders/referred`, {
              headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(response.status()).toBe(200);
            const { items } = await response.json();
            return items.some(
              (o: { orderId: string; assignedToMe: boolean }) => o.orderId === orderId && o.assignedToMe,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const target = outcome === "REQUESTER" ? "requester" : "courier";
      const reason = `Rehearsal ${outcome}: the evidence supports the ${target}.${outcome === "COURIER" ? ` ${"evidence".repeat(35)}` : ""}`;
      await admin.goto(`/admin/errands/${orderId}`);
      await admin.getByRole("button", { name: `Decide for the ${target}`, exact: true }).click();
      await admin.getByRole("dialog").getByRole("textbox", { name: "Reason" }).fill(reason);
      await admin
        .getByRole("dialog")
        .getByRole("button", { name: `Decide for the ${target}`, exact: true })
        .click();
      await expect(admin.getByRole("dialog")).toBeHidden();
      for (const participant of [page, courier.page]) {
        await participant.reload();
        await expect(status(participant, outcome === "REQUESTER" ? "Cancelled" : "Complete")).toBeVisible({
          timeout: 30_000,
        });
        const history = participant.getByRole("region", { name: "Errand history" }).filter({ visible: true });
        await expect(
          history.getByRole("heading", { name: `Decided for the ${target}`, exact: true }),
        ).toBeVisible();
        await expect(history.getByText(reason, { exact: true })).toBeVisible();
        expect(await participant.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(participant.viewportSize()!.width);
        await expect(history.locator("time").first()).toHaveAttribute("datetime", /T.*Z$/);
        await history.getByText("View status history", { exact: true }).click();
        await expect(history.getByRole("list")).toBeVisible();
      }
      const rejected = await outsider.page.request.get(`${ORDER}/orders/${orderId}/history`, {
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      expect(rejected.status()).toBe(403);
      expect(await rejected.text()).not.toContain(reason);
      await outsider.page.goto(orderUrl);
      await expect(outsider.page.getByRole("region", { name: "Errand history" })).toHaveCount(0);
      await expect(outsider.page.getByText(reason, { exact: true })).toHaveCount(0);
      await expect
        .poll(() => funds({ request: page.request, token: requesterToken }))
        .toEqual({
          available: requesterBefore.available - (outcome === "COURIER" ? 1 : 0),
          reserved: requesterBefore.reserved,
        });
      await expect
        .poll(() => funds({ request: courier.page.request, token: courier.token }))
        .toEqual({
          available: courierBefore.available + (outcome === "COURIER" ? 1 : 0),
          reserved: courierBefore.reserved,
        });
    }
  } finally {
    await Promise.all(
      [...contexts.map((actor) => actor.context), adminContext].map((context) => context.close()),
    );
  }
});

const status = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true });
async function act(page: Page, name: string, confirm: string) {
  await page.getByRole("button", { name, exact: true }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
