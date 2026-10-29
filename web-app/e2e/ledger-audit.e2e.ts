import { expect, test } from "@playwright/test";
import { adminSession } from "./admin-helpers";

test("an administrator runs the financial audit through Operations and sees the persisted result", async ({ page }) => {
  const edge = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const { token: accessToken } = await adminSession(page);
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
