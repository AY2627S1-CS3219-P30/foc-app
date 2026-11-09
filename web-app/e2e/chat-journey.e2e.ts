import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ORDER, errandEmail, firstSupplier, signIn } from "./request-helpers";

const CHAT = `${process.env.E2E_BASE_URL ?? "http://localhost:3000"}/api/chat`;
async function openChat(page: Page) {
  // The panel mounts once the order has loaded; only then does the toggle exist to be checked.
  await expect(page.getByRole("region", { name: "Participant chat", exact: true })).toBeVisible();
  const toggle = page.getByRole("button", { name: "Open chat", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}
/** #346: with both sockets ready, polling is a 30 s backstop, so only a nudge arrives within 1 s. */
const NUDGED_WITHIN_MS = 1_000;
function socketReady(page: Page) {
  return page
    .waitForEvent("websocket", {
      predicate: (ws) => ws.url().endsWith("/api/chat/socket"),
      timeout: 10_000,
    })
    .then((ws) =>
      ws.waitForEvent("framereceived", {
        predicate: (frame) => frame.payload === '{"type":"ready"}',
        timeout: 10_000,
      }),
    );
}

/** Real edge/services, two browser sessions, all release breakpoints; no mocked requests. */
test("chat: send, receive, offline catch-up, outsider refusal and final-state closure", async ({
  browser,
  page,
  request,
}, info) => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack.");
  test.setTimeout(120_000);
  const token = await signIn(page.request, errandEmail("requester"));
  const courierContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: page.viewportSize(),
  });
  const courier = await courierContext.newPage();
  const courierToken = await signIn(courier.request, errandEmail("loser"));
  const outsider = await signIn(request, errandEmail("winner"));
  const auth = { authorization: `Bearer ${token}` };
  const courierAuth = { authorization: `Bearer ${courierToken}` };
  try {
    const supplier = await firstSupplier(request, token);
    const created = await request.post(`${ORDER}/orders`, {
      headers: { ...auth, "idempotency-key": randomUUID() },
      data: {
        supplierId: supplier.supplierId,
        items: [{ name: `Chat ${info.project.name}`, quantity: 1 }],
        deliveryZone: "PGP House 7",
        deliveryInstructions: "Leave it at the lobby counter.",
        reward: 1,
      },
    });
    expect(created.status()).toBe(201);
    const { orderId } = await created.json();
    const readOrder = async () =>
      (await request.get(`${ORDER}/orders/${orderId}`, { headers: auth })).json();
    await expect.poll(async () => (await readOrder()).status, { timeout: 30000 }).toBe("OPEN");
    const accepted = await request.post(`${ORDER}/orders/${orderId}/accept`, {
      headers: courierAuth,
      data: { expectedVersion: (await readOrder()).version },
    });
    expect(accepted.status()).toBe(201);
    const ready = Promise.all([socketReady(page), socketReady(courier)]);
    await page.goto(`/request/${orderId}`);
    await courier.goto(`/request/${orderId}`);
    await openChat(page);
    await openChat(courier);
    await ready;
    const panel = page.getByRole("region", { name: "Participant chat", exact: true });
    const otherPanel = courier.getByRole("region", { name: "Participant chat", exact: true });
    const send = async (from: typeof panel, body: string) => {
      await from.getByRole("textbox", { name: "Message", exact: true }).fill(body);
      await from.getByRole("button", { name: "Send", exact: true }).click();
    };
    await send(panel, "Meet at the COM2 entrance?");
    await expect(otherPanel.getByText("Meet at the COM2 entrance?", { exact: true })).toBeVisible({
      timeout: NUDGED_WITHIN_MS,
    });
    await send(otherPanel, "Yes, by the stairs.");
    await expect(panel.getByText("Yes, by the stairs.", { exact: true })).toBeVisible({
      timeout: NUDGED_WITHIN_MS,
    });

    await test.step("with its socket blocked, a panel sends and receives on polling", async () => {
      await courier.routeWebSocket("**/api/chat/socket", (ws) => ws.close({ code: 4503 }));
      await courier.reload();
      await openChat(courier);
      await send(panel, "Blocked socket, still here?");
      await expect(
        otherPanel.getByText("Blocked socket, still here?", { exact: true }),
      ).toBeVisible({
        timeout: 10000,
      });
      await send(otherPanel, "Yes, on polling.");
      await expect(panel.getByText("Yes, on polling.", { exact: true })).toBeVisible({
        timeout: NUDGED_WITHIN_MS,
      });
      await courier.unrouteAll();
    });

    await test.step("an offline participant catches up with all missed messages", async () => {
      await page.context().setOffline(true);
      for (let i = 1; i <= 3; i++) {
        const response = await courier.request.post(`${CHAT}/channels/${orderId}/messages`, {
          headers: courierAuth,
          data: { clientId: randomUUID(), body: `Offline update ${i}` },
        });
        expect(response.status()).toBe(201);
      }
      await page.context().setOffline(false);
      // Foreground/online events use the same catch-up path as the polling timer.
      await page.bringToFront();
      for (let i = 1; i <= 3; i++)
        await expect(panel.getByText(`Offline update ${i}`, { exact: true })).toHaveCount(1, {
          timeout: 10000,
        });
    });
    await test.step("an outsider is refused by the Chat Service", async () => {
      for (const suffix of ["", "/messages"]) {
        const response = await request.get(`${CHAT}/channels/${orderId}${suffix}`, {
          headers: { authorization: `Bearer ${outsider}` },
        });
        expect(response.status()).toBe(403);
        expect(await response.text()).not.toContain("COM2 entrance");
      }
      const response = await request.post(`${CHAT}/channels/${orderId}/messages`, {
        headers: { authorization: `Bearer ${outsider}` },
        data: { clientId: randomUUID(), body: "Forbidden" },
      });
      expect(response.status()).toBe(403);
    });
    await test.step("a final state disables sending and keeps the history readable", async () => {
      const response = await request.post(`${ORDER}/orders/${orderId}/cancel`, {
        headers: auth,
        data: { expectedVersion: (await readOrder()).version },
      });
      expect(response.status()).toBe(200);
      await expect
        .poll(async () => (await readOrder()).status, { timeout: 30000 })
        .toBe("CANCELLED");
      await expect(panel.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled({
        timeout: 35000,
      });
      await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      await expect(panel.getByText("Meet at the COM2 entrance?", { exact: true })).toBeVisible();
    });
  } finally {
    await page.context().setOffline(false);
    await courierContext.close();
  }
});
