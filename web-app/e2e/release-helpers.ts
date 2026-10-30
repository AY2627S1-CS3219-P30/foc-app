import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { compose, firstSupplier, ORDER, ORDER_URL, releaseEmail, signIn, USER } from "./request-helpers";

const actors = new WeakMap<Page, { id: string; token: string }>();
export function actor(page: Page) {
  const identity = actors.get(page);
  if (!identity) throw new Error("This page has no release student fixture.");
  return identity;
}
export async function extraPage(browser: Browser, like: Page) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: like.viewportSize(),
  });
  return context.newPage();
}
export async function student(browser: Browser, like: Page, who: "courier" | "replacement") {
  const page = await extraPage(browser, like);
  const token = await signIn(page.request, releaseEmail(who));
  const mode = await page.request.patch(`${USER}/users/me`, {
    headers: { authorization: `Bearer ${token}` },
    data: { preferredMode: "COURIER" },
  });
  expect(mode.status()).toBe(200);
  const response = await page.request.get(`${USER}/users/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  actors.set(page, { id, token });
  return page;
}
export async function post(page: Page, token: string, label: string) {
  const supplier = await firstSupplier(page.request, token);
  const item = `${label} ${test.info().project.name} ${Date.now()}`;
  await compose(page, { supplier: supplier.name, item, reward: 1 });
  const response = page.waitForResponse(
    (r) => r.url() === `${ORDER}/orders` && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Post request" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const { orderId } = await created.json();
  await expect(page).toHaveURL(ORDER_URL);
  await badge(page, "Open");
  return { orderId: orderId as string, item };
}
export async function act(page: Page, label: string, confirm: string) {
  await page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
export async function reason(page: Page, label: string, confirm: string, explanation: string) {
  await page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Reason" }).fill(explanation);
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
export async function badge(page: Page, label: string) {
  await expect(page.getByText(label, { exact: true }).filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}
export async function readOrder(page: Page, token: string, orderId: string) {
  const response = await page.request.get(`${ORDER}/orders/${orderId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
export async function waitStatus(page: Page, token: string, orderId: string, status: string) {
  await expect
    .poll(async () => (await readOrder(page, token, orderId)).status, { timeout: 30_000 })
    .toBe(status);
}

/** Changes only the mounted non-secret clock fixture, never an application database row. */
export async function advanceServerClockTo(at: string) {
  const file = process.env.E2E_CLOCK_HOST_FILE;
  if (
    process.env.E2E_RELEASE !== "1" ||
    !file ||
    resolve(file) !== resolve(process.cwd(), "../.release-results/clock/offset-ms")
  )
    throw new Error("Use the dedicated release runner for server-clock journeys.");
  const before = Number(readFileSync(file, "utf8").trim());
  const next = Math.max(before, Date.parse(at) - Date.now() + 1_000);
  if (!Number.isSafeInteger(next) || next < 0 || next > 14 * 24 * 60 * 60_000)
    throw new Error("Release clock advance is outside the supported fourteen-day window.");
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${next}\n`, { mode: 0o644, flag: "wx" });
  chmodSync(temporary, 0o644);
  renameSync(temporary, file);
  // Docker Desktop propagates a host bind-mount update asynchronously. Do not sign in with
  // Identity's old clock while Order has already advanced: that yields an already-expired JWT.
  // Read the fixture through the same preload in each container; no application data is touched.
  const target = Date.now() + next;
  await Promise.all(
    ["user-service", "supplier-service", "order-service", "credit-service", "chat-service"].map(async (service) => {
      await expect
        .poll(
          async () => {
            const { stdout } = await promisify(execFile)(
              "docker",
              ["compose", "exec", "-T", service, "node", "-p", "Date.now()"],
              { cwd: resolve(process.cwd(), ".."), timeout: 10_000 },
            );
            return Number(stdout.trim());
          },
          { timeout: 30_000, message: `${service} must observe the release clock before sign-in` },
        )
        .toBeGreaterThanOrEqual(target);
    }),
  );
}
