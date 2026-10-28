import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

function bootstrap(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const value = readFileSync(resolve(process.cwd(), "../.env"), "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) throw new Error(`Set ${name} or initialize the disposable E2E stack.`);
  return value;
}

/** Claims only the configured test administrator; never prints or stores its password in reports. */
export async function adminSession(page: Page, throughForm = false) {
  const edge = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const email = bootstrap("ADMIN_SEED_EMAILS").split(",")[0].trim();
  const seedPassword = bootstrap("ADMIN_SEED_PASSWORD");
  // Shared with the ledger-audit journey, so either spec may run first on a clean stack.
  const password = process.env.E2E_ADMIN_PASSWORD ?? createHash("sha256")
    .update(`${seedPassword}:ledger-audit-e2e`).digest("hex");
  const login = (password: string) => page.request.post(`${edge}/api/user/auth/login`, {
    data: { email, password },
  });
  let response = await login(password);
  if (response.status() === 401 && !process.env.E2E_ADMIN_PASSWORD) {
    const initial = await login(seedPassword);
    expect((await initial.json()).error?.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const changed = await page.request.post(`${edge}/api/user/auth/password`, {
      data: { email, currentPassword: seedPassword, newPassword: password },
    });
    expect(changed.status()).toBe(204);
    response = await login(password);
  }
  expect(response.status()).toBe(200);
  const { accessToken } = await response.json();
  if (throughForm) {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByRole("textbox", { name: "NUS email" }).fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
  }
  return { token: accessToken as string, email };
}
