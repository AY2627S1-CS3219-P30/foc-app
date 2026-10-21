import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end checks for the account journey (USR-05) against the real stack: `docker compose up`
 * serves the web app on :3000 and the User Service behind it, with the dev mailbox mounted. Nothing
 * here is mocked. The three projects are the README's breakpoints.
 *
 * Specs are `*.e2e.ts`, never `*.test.ts` or `*.spec.ts`, so `bun test` does not pick them up.
 */
const at = (width: number, height: number) => ({ ...devices["Desktop Chrome"], viewport: { width, height } });

// Set once here and inherited by every worker, so specs can share accounts across projects and retries.
process.env.E2E_RUN ??= String(Date.now());

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // One at a time, so projects never race to register a shared account. The User Service limits
  // sign-ups and logins per IP, whatever the worker count; staying inside them is up to the specs.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "360px", use: at(360, 780) },
    { name: "768px", use: at(768, 1024) },
    { name: "1440px", use: at(1440, 900) },
  ],
});
