import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { tabTo, typeInto } from "./keyboard-helpers";
import { badge, student } from "./release-helpers";
import { firstSupplier, ORDER_URL, releaseEmail, signIn, USER } from "./request-helpers";

/**
 * UI-NFR2.1.2 (#166): the whole errand journey by keyboard alone, at every breakpoint. The requester
 * signs in, composes and posts; a courier accepts, records pickup and delivery; the requester
 * confirms receipt and follows the receipt to the payment in the wallet. Only Tab, Enter and the
 * arrow keys drive the pages (no click() or fill()); every focus stop shows a visible ring, and Tab
 * never sticks. The courier signs in through the API: the requester already proves the form.
 *
 * UI-NFR3.1.2: each submit or state change shows its pending, disabled or opened state within
 * 100 ms of the key. That is timed inside the page, from the keydown event to the frame after the
 * change, so the test runner's own latency is not counted; the times are annotations.
 */
const PASSWORD = "a long enough passphrase";
const FEEDBACK_MS = 100;

/**
 * Presses Enter on the focused control and resolves the milliseconds from the keydown to the first
 * frame that shows feedback: the control disabled or gone, a dialog opened, or the page navigated.
 */
async function enterWithFeedback(page: Page, testInfo: TestInfo, action: string) {
  await page.evaluate(() => {
    const control = document.activeElement as HTMLButtonElement;
    const opener = !control.closest("dialog");
    const shown = () =>
      control.disabled ||
      !control.isConnected ||
      control.getAttribute("aria-busy") === "true" ||
      (opener && !!document.querySelector("dialog[open]"));
    const w = window as unknown as { feedback: Promise<number> };
    w.feedback = new Promise((resolve) => {
      let start = 0;
      const painted = () =>
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve(performance.now() - start);
          channel.port2.postMessage(null);
        });
      addEventListener("keydown", (e) => void (start = e.timeStamp), { capture: true, once: true });
      addEventListener("pagehide", () => resolve(performance.now() - start), { once: true });
      const observer = new MutationObserver(() => {
        if (!start || !shown()) return;
        observer.disconnect();
        painted();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  });
  await page.keyboard.press("Enter");
  const ms = await page.evaluate(() => (window as unknown as { feedback: Promise<number> }).feedback);
  testInfo.annotations.push({ type: "feedback", description: `${action}: ${ms.toFixed(1)} ms` });
  expect(ms, `${action} showed no feedback within ${FEEDBACK_MS} ms`).toBeLessThanOrEqual(FEEDBACK_MS);
}

/** In the open confirmation, reaches its confirm button by keyboard (an undoable one opens on Go back). */
async function confirm(page: Page, testInfo: TestInfo, label: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const button = dialog.getByRole("button", { name: label, exact: true });
  if (!(await button.evaluate((el) => el === document.activeElement))) await tabTo(page, button, 5);
  await expect(button).toBeFocused();
  await enterWithFeedback(page, testInfo, `confirm "${label}"`);
  await expect(dialog).toBeHidden();
}

/** Tabs to an errand action, opens its confirmation by keyboard, and confirms it. */
async function act(page: Page, testInfo: TestInfo, label: string, confirmLabel: string) {
  const button = page.getByRole("button", { name: label, exact: true }).filter({ visible: true });
  await tabTo(page, button, 60);
  await enterWithFeedback(page, testInfo, `open "${label}"`);
  await confirm(page, testInfo, confirmLabel);
}

/** Tab keeps moving: it never stays on one element, and comes round to where it started. */
async function expectNoTrap(page: Page, maxStops = 150) {
  const seen: string[] = [];
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    const here = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const path: number[] = [];
      for (let n: Element | null = el; n?.parentElement; n = n.parentElement)
        path.unshift([...n.parentElement.children].indexOf(n));
      return path.join(".");
    });
    if (seen.length && seen.at(-1) === here && here !== "body") throw new Error(`Tab is stuck on ${here}`);
    if (here === "body" || seen.includes(here)) return;
    seen.push(here);
  }
  throw new Error(`Tab did not come round within ${maxStops} stops`);
}

const press = (page: Page, target: Locator) => tabTo(page, target, 60).then(() => page.keyboard.press("Enter"));

test.describe("keyboard-only errand journey @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack with E2E_RELEASE=1.");
  test.describe.configure({ timeout: 120_000 });

  test("an errand from sign-in to the wallet, by keyboard alone", async ({ browser, page }, testInfo) => {
    const email = releaseEmail("a11y");
    const token = await signIn(page.request, email);
    const mode = await page.request.patch(`${USER}/users/me`, {
      headers: { authorization: `Bearer ${token}` },
      data: { preferredMode: "REQUESTER" },
    });
    expect(mode.status()).toBe(200);
    const supplier = await firstSupplier(page.request, token);
    const item = `Keyboard ${testInfo.project.name} ${Date.now()}`;
    await page.context().clearCookies();
    const courier = await student(browser, page, "courier");

    try {
      await test.step("sign in", async () => {
        await page.goto("/login");
        await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
        await typeInto(page, page.getByRole("textbox", { name: "NUS email", exact: true }), email);
        await typeInto(page, page.getByRole("textbox", { name: "Password", exact: true }), PASSWORD);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/feed$/);
      });

      await test.step("compose and post the request", async () => {
        const start = page.getByRole("button", { name: "New request" }).filter({ visible: true });
        await expect(start).toBeVisible();
        await press(page, start);
        await expect(page).toHaveURL(/\/request\/new$/);
        await typeInto(page, page.getByRole("searchbox", { name: "Search pickup points" }), supplier.name);
        const option = page.getByRole("button", { name: supplier.name });
        await expect(option).toHaveCount(1);
        await press(page, option);
        await expect(page).toHaveURL(/\/request\/new\/details\?supplierId=/);

        await expect(page.getByRole("button", { name: "Review request" })).toBeVisible();
        await typeInto(page, page.getByRole("textbox", { name: "Name", exact: true }), item);
        await typeInto(page, page.getByRole("textbox", { name: "Delivery zone" }), "PGP House 7");
        await typeInto(page, page.getByRole("textbox", { name: "Delivery instructions" }), "Leave it at the lobby counter.");
        const credits = page.getByRole("slider", { name: "Credits" });
        await tabTo(page, credits);
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowLeft");
        await expect(credits).toHaveValue("1");
        await press(page, page.getByRole("button", { name: "Review request" }));
        await expect(page).toHaveURL(/\/request\/new\/review\?supplierId=/);

        const post = page.getByRole("button", { name: "Post request" });
        await expect(post).toBeEnabled();
        await tabTo(page, post);
        await enterWithFeedback(page, testInfo, 'post the request ("Posting…")');
        await expect(page).toHaveURL(ORDER_URL);
        await badge(page, "Open");
      });
      const orderUrl = page.url();

      await test.step("a courier accepts from the board, then records pickup and delivery", async () => {
        await courier.goto("/feed");
        const accept = courier
          .locator(".card", { hasText: item })
          .filter({ visible: true })
          .getByRole("button", { name: /^Accept errand from / });
        await expect(accept).toBeVisible();
        await tabTo(courier, accept, 80);
        await enterWithFeedback(courier, testInfo, "open accept from the board");
        await confirm(courier, testInfo, "Accept");
        await expect(courier).toHaveURL(ORDER_URL);
        await badge(courier, "Accepted");
        await act(courier, testInfo, "I've picked it up", "Record pickup");
        await badge(courier, "In transit");
        await act(courier, testInfo, "Mark as delivered", "Record delivery");
        await badge(courier, "Delivered");
      });

      await test.step("the requester confirms receipt", async () => {
        await expect(page).toHaveURL(orderUrl);
        await badge(page, "Delivered, confirm receipt");
        await act(page, testInfo, "Confirm receipt", "Confirm receipt");
        await badge(page, "Complete");
      });

      await test.step("the receipt leads to the payment in the wallet", async () => {
        await press(page, page.getByRole("link", { name: "View receipt" }).filter({ visible: true }));
        await expect(page).toHaveURL(/\/receipt$/);
        await press(page, page.getByRole("link", { name: "See it in your wallet" }).filter({ visible: true }));
        await expect(page).toHaveURL(/\/wallet\?tx=[0-9a-f-]{36}$/);
        const payment = page.locator('[aria-current="true"]');
        await expect(payment).toBeFocused();
        await expect(payment).toContainText("Paid your courier");
        await expectNoTrap(page);
      });
    } finally {
      await courier.context().close();
    }
  });
});
