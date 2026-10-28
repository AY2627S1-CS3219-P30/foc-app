import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * End-to-end checks for the account journey (USR-05) against the real stack: `docker compose up`
 * serves the web app on :3000 and the User Service behind it, with the dev mailbox mounted. Nothing
 * here is mocked. The three projects are the README's breakpoints.
 *
 * Specs are `*.e2e.ts`, never `*.test.ts` or `*.spec.ts`, so `bun test` does not pick them up.
 */
const at = (width: number, height: number) => ({ ...devices["Desktop Chrome"], viewport: { width, height } });

// The runner makes a fresh ID per invocation; workers reload this config and keep its inherited ID.
if (process.env.TEST_WORKER_INDEX === undefined) process.env.E2E_RUN = randomUUID();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One at a time, so projects never act on the shared errand accounts at once. The User Service
  // limits sign-ups and logins per IP, whatever the worker count; staying inside them is up to the specs.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.E2E_RELEASE === "1" ? 0 : process.env.CI ? 1 : 0,
  maxFailures: process.env.E2E_RELEASE === "1" ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // CI drives the runner's installed Google Chrome ("chrome"), so nothing is downloaded there;
    // unset, Playwright uses its own Chromium (`bunx playwright install chromium`).
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "360px", use: at(360, 780) },
    { name: "768px", use: at(768, 1024) },
    { name: "1440px", use: at(1440, 900) },
  ],
});
