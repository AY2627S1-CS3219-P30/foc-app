import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Same private bootstrap configuration Compose uses. Never put its password in the test source.
function bootstrap(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const env = readFileSync(resolve(process.cwd(), "../.env"), "utf8");
  const value = env.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`Set ${name} or create the Compose .env before the ledger audit E2E.`);
  return value;
}

test("an administrator runs the financial audit through Operations and sees the persisted result", async ({ page }) => {
  const edge = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const email = bootstrap("ADMIN_SEED_EMAILS").split(",")[0].trim();
  const seedPassword = bootstrap("ADMIN_SEED_PASSWORD");
  // Disposable E2E stacks require replacing the bootstrap password before any admin session.
  // Derivation keeps reruns stable without writing the private credential into tracked fixtures.
  const password = process.env.E2E_ADMIN_PASSWORD ?? createHash("sha256").update(`${seedPassword}:ledger-audit-e2e`).digest("hex");
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
  await page.goto("/admin/operations");
  const section = page.getByRole("region", { name: "Daily credit ledger audit" });
  await expect(section).toBeVisible();
  const run = section.getByRole("button", { name: "Run ledger audit", exact: true });
  await expect(run).toBeEnabled();
  const finished = page.waitForResponse((r) => r.url().endsWith("/api/credit/admin/ledger-audits/run") && r.request().method() === "POST");
  await run.click();
  const completed = await finished;
  expect(completed.status()).toBe(200);
  const result = (await completed.json()).run;
  expect(result).toMatchObject({ status: "PASS", mismatchCount: 0, origin: "MANUAL" });
  expect(result.checks).toHaveLength(6);
  await expect(section.getByText(`Run ID: ${result.runId}`)).toBeVisible();
  await expect(section.getByText("0 mismatch(es).", { exact: false })).toBeVisible();
  const latest = await page.request.get(`${edge}/api/credit/admin/ledger-audits/latest`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(latest.status()).toBe(200);
  expect((await latest.json()).run.runId).toBe(result.runId);
});
