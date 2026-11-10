import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { adminSession } from "./admin-helpers";
import { act, badge, student } from "./release-helpers";
import { compose, firstSupplier, ORDER, ORDER_URL, releaseEmail, signIn, USER } from "./request-helpers";

/**
 * UI-NFR2.1.1 (#166): axe on every core screen, at every breakpoint (the release suite allows no
 * skipped test, so 768 px runs beside the 360 and 1440 px the requirement names). The rules are
 * WCAG 2.0 and 2.1 A and AA plus axe's best practices, which hold the landmark and heading rules.
 * Every screen is scanned before anything is asserted, so one run reports them all; each screen's
 * count by impact is an annotation and the full results an attachment.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
type Finding = { screen: string; impact: string; id: string; targets: string[] };

async function scan(page: Page, testInfo: TestInfo, screen: string, findings: Finding[]) {
  // Content fades in as it arrives; scanned mid-fade, its text reads as low contrast. Let one-off
  // animations settle first (endless ones, such as a skeleton's shimmer, never finish).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const counts: Record<string, number> = {};
  for (const v of violations) {
    counts[v.impact ?? "none"] = (counts[v.impact ?? "none"] ?? 0) + 1;
    findings.push({
      screen,
      impact: v.impact ?? "none",
      id: v.id,
      targets: v.nodes.map((n) => n.target.join(" ")),
    });
  }
  testInfo.annotations.push({ type: "axe", description: `${screen}: ${JSON.stringify(counts)}` });
  // axe ignores a copy hidden by CSS, so it can't see a page with two trees (#367). Count them all.
  const { main, h1 } = await page.evaluate(() => ({
    main: document.querySelectorAll("main").length,
    h1: document.querySelectorAll("h1").length,
  }));
  if (main !== 1 || h1 !== 1) {
    findings.push({ screen, impact: "structure", id: "one-main-and-h1", targets: [`${main} main, ${h1} h1`] });
  }
}

async function report(testInfo: TestInfo, findings: Finding[]) {
  await testInfo.attach("axe-findings.json", {
    body: JSON.stringify(findings, null, 2),
    contentType: "application/json",
  });
  expect(
    findings.map((f) => `${f.screen}: ${f.impact} ${f.id}: ${f.targets.join(" | ")}`),
    "axe issues",
  ).toEqual([]);
}

const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { name, exact: typeof name === "string" }).filter({ visible: true }).first();

test.describe("accessibility of every core screen @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack with E2E_RELEASE=1.");
  test.describe.configure({ timeout: 120_000 });

  test("axe finds no issue on the student screens", async ({ browser, page }, testInfo) => {
    const findings: Finding[] = [];
    // Opened from an emailed link, the page asks for a password and activates nothing (#309).
    await page.goto(`/activate?token=${"a".repeat(43)}`);
    await expect(page.getByRole("button", { name: "Activate account" })).toBeEnabled();
    await scan(page, testInfo, "activate: choose a password", findings);
    const token = await signIn(page.request, releaseEmail("a11y"));
    const courier = await student(browser, page, "courier");
    try {
      await page.goto("/feed");
      await expect(page.getByRole("button", { name: "New request" }).filter({ visible: true })).toBeVisible();
      // The button renders before the list: wait for the list too, so axe scans content, not a skeleton.
      await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
      await scan(page, testInfo, "feed (requester)", findings);

      const supplier = await firstSupplier(page.request, token);
      await page.goto("/request/new");
      await expect(page.getByRole("button", { name: supplier.name })).toBeVisible();
      await scan(page, testInfo, "composer: pickup point", findings);
      await page.goto(`/request/new/details?supplierId=${supplier.supplierId}`);
      await expect(page.getByRole("button", { name: "Review request" })).toBeVisible();
      await scan(page, testInfo, "composer: details", findings);

      await compose(page, { supplier: supplier.name, item: `Axe ${testInfo.project.name} ${Date.now()}`, reward: 1 });
      await expect(page.getByRole("button", { name: "Post request" })).toBeEnabled();
      await scan(page, testInfo, "composer: review", findings);
      await page.getByRole("button", { name: "Post request" }).click();
      await expect(page).toHaveURL(ORDER_URL);
      const orderId = new URL(page.url()).pathname.split("/").pop()!;
      await badge(page, "Open");
      await scan(page, testInfo, "active errand: requester, open", findings);

      await courier.goto("/feed");
      await expect(courier.getByRole("button", { name: /^Accept errand from / }).first()).toBeVisible();
      await scan(courier, testInfo, "feed (courier)", findings);
      await courier.goto(`/request/${orderId}`);
      await courier.getByRole("button", { name: "Accept errand", exact: true }).filter({ visible: true }).click();
      await expect(courier.getByRole("dialog")).toBeVisible();
      await scan(courier, testInfo, "active errand: courier, confirm dialog", findings);
      await courier.getByRole("dialog").getByRole("button", { name: "Accept", exact: true }).click();
      await expect(courier.getByRole("dialog")).toBeHidden();
      await badge(courier, "Accepted");
      await scan(courier, testInfo, "active errand: courier, accepted", findings);
      await act(courier, "I've picked it up", "Record pickup");
      await act(courier, "Mark as delivered", "Record delivery");

      await page.reload();
      await badge(page, "Delivered, confirm receipt");
      await scan(page, testInfo, "active errand: requester, delivered", findings);
      await act(page, "Confirm receipt", "Confirm receipt");
      await badge(page, "Complete");
      await scan(page, testInfo, "errand: requester, complete", findings);

      await page.goto(`/request/${orderId}/receipt`);
      await expect(page.getByRole("link", { name: "See it in your wallet" }).filter({ visible: true })).toBeVisible();
      await scan(page, testInfo, "receipt", findings);
      await page.goto("/wallet");
      await expect(page.getByText("Paid your courier").filter({ visible: true }).first()).toBeVisible();
      await scan(page, testInfo, "wallet", findings);
      await page.goto("/order-history");
      await expect(page.locator(".card").filter({ visible: true }).first()).toBeVisible();
      await scan(page, testInfo, "history", findings);
      await page.goto("/suppliers");
      await expect(page.getByRole("searchbox", { name: "Search suppliers" })).toBeVisible();
      await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
      await scan(page, testInfo, "suppliers", findings);
      await page.goto("/profile");
      await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
      await scan(page, testInfo, "profile", findings);
      await page.goto("/change-password");
      await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
      await expect(page.locator("input[name=newPassword]")).toBeVisible();
      await scan(page, testInfo, "change password", findings);
    } finally {
      await courier.context().close();
    }
    await report(testInfo, findings);
  });

  test("axe finds no issue in the admin console", async ({ page, request }, testInfo) => {
    const findings: Finding[] = [];
    const studentToken = await signIn(request, releaseEmail("a11y"));
    const me = await request.get(`${USER}/users/me`, { headers: { authorization: `Bearer ${studentToken}` } });
    expect(me.status()).toBe(200);
    const { id: studentId } = await me.json();
    const { token } = await adminSession(page, true);
    const errands = await page.request.get(`${ORDER}/admin/orders`, {
      headers: { authorization: `Bearer ${token}` },
      params: { pageSize: 1 },
    });
    expect(errands.status()).toBe(200);
    const [errand] = (await errands.json()).items as { orderId: string }[];
    expect(errand, "the student test posts an errand first").toBeTruthy();
    const screens: [string, string | RegExp][] = [
      ["/admin", "Overview"],
      ["/admin/users", "Users"],
      [`/admin/users/${studentId}`, "Account"],
      ["/admin/role-requests", "Role requests"],
      ["/admin/audit", "Audit trail"],
      ["/admin/activity", "Admin activity"],
      ["/admin/errands", "Errands"],
      [`/admin/errands/${errand.orderId}`, /^Dispute/],
      ["/admin/wallets", "Wallets"],
      ["/admin/operations", "Operations"],
    ];
    for (const [path, title] of screens) {
      await page.goto(path);
      await expect(heading(page, title)).toBeVisible();
      await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
      await scan(page, testInfo, path.replace(/[0-9a-f-]{36}/, ":id"), findings);
    }
    await report(testInfo, findings);
  });
});
