import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { activationLink } from "./mailpit";

/**
 * USR-05 acceptance criteria, end to end, once per breakpoint (see playwright.config.ts):
 * - the journey works at 360, 768 and 1440 px, with nothing scrolling sideways;
 * - a failed submit keeps what was typed and marks the offending field;
 * - sign-up, activation and sign-in are done by keyboard alone, and every focus stop is visible;
 * - axe reports no critical or serious issue on any account screen;
 * - every call goes to the real User Service.
 *
 * Only the keyboard drives the forms: no click() or fill().
 */

const PASSWORD = "a long enough passphrase";

test("account journey: register, activate, sign in, profile, mode switch, log out", async ({
  page,
}, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now()}@u.nus.edu`;
  const name = "E2E Student";

  await test.step("a signed-out visitor is sent to sign in", async () => {
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);
  });

  await test.step("register: a failed submit keeps the input and marks the field", async () => {
    await page.goto("/register");
    await hydrated(page.getByRole("button", { name: "Create account" }));
    await checkScreen(page, testInfo, "register");

    await typeInto(page, field(page, "NUS email"), email);
    await typeInto(page, field(page, "Display name"), name);
    await typeInto(page, field(page, "Password"), PASSWORD);
    const confirm = field(page, "Confirm password");
    await typeInto(page, confirm, "not the same passphrase");
    await page.keyboard.press("Enter");

    await expect(confirm).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("The passwords don't match.")).toBeVisible();
    await expect(field(page, "NUS email")).toHaveValue(email);
    await expect(field(page, "Display name")).toHaveValue(name);
    await expect(field(page, "Password")).toHaveValue(PASSWORD);
    await checkScreen(page, testInfo, "register (field error)");

    // Focus is still in the confirm field.
    await replaceFocused(page, PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await checkScreen(page, testInfo, "register (sent)");
  });

  await test.step("activate from the link in the email", async () => {
    await page.goto(await activationLink(page.request, email));
    await expect(page.getByRole("heading", { name: "Account activated" })).toBeVisible();
    await checkScreen(page, testInfo, "activate");
    await tabTo(page, page.getByRole("link", { name: "Sign in", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login$/);
  });

  await test.step("sign in: a rejected password keeps the input, then succeeds", async () => {
    await hydrated(page.getByRole("button", { name: "Sign in" }));
    await checkScreen(page, testInfo, "login");

    await typeInto(page, field(page, "NUS email"), email);
    const password = field(page, "Password");
    await typeInto(page, password, "the wrong passphrase");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "don't match an account" })).toBeVisible();
    await expect(field(page, "NUS email")).toHaveValue(email);
    await expect(password).toHaveValue("the wrong passphrase");
    await checkScreen(page, testInfo, "login (rejected)");

    await expect(password).toBeFocused();
    await replaceFocused(page, PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/feed$/);
  });

  await test.step("profile: the mode switch is saved on the server", async () => {
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await checkScreen(page, testInfo, "profile");

    const requester = page.getByRole("radio", { name: "Requester" }).first();
    const courier = page.getByRole("radio", { name: "Courier" }).first();
    const [from, to] = (await requester.isChecked()) ? [requester, courier] : [courier, requester];
    await tabTo(page, from);
    // Wait for the save itself: the switch is not busy yet the moment the key lands.
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/users/me") && r.request().method() === "PATCH",
    );
    await page.keyboard.press("ArrowRight");
    await expect(to).toBeChecked();
    expect((await saved).ok(), "the mode switch was not saved").toBe(true);

    await page.reload();
    await expect(to).toBeChecked();
  });

  await test.step("log out, then signing in again returns to the page asked for", async () => {
    await tabTo(page, page.getByRole("button", { name: "Log out" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);

    await hydrated(page.getByRole("button", { name: "Sign in" }));
    await typeInto(page, field(page, "NUS email"), email);
    await typeInto(page, field(page, "Password"), PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  });
});

/** A form control by its accessible name; the visible label also carries the required marker. */
test("an activation link that was replaced is refused, and the new one from the activate screen works", async ({
  page,
}, testInfo) => {
  const email = `e2e-resend-${testInfo.project.name}-${Date.now()}@u.nus.edu`;
  const USER = process.env.E2E_USER_SERVICE_URL ?? "http://localhost:3001";
  const registered = await page.request.post(`${USER}/auth/register`, {
    data: { email, password: PASSWORD, displayName: "E2E Resend" },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const first = await activationLink(page.request, email);

  await test.step("ask for a new link by keyboard", async () => {
    await page.goto("/activate");
    const send = page.getByRole("button", { name: "Send a new link" });
    await hydrated(send);
    await typeInto(page, field(page, "NUS email"), email);
    await page.keyboard.press("Enter");
    await expect(page.getByText(/a new link is on its way/)).toBeVisible();
    await checkScreen(page, testInfo, "activate (resent)");
  });

  const second = await activationLink(page.request, email, first);

  await test.step("the old link is refused and points to a new one", async () => {
    await page.goto(first);
    await expect(page.getByText(/This activation link isn't valid/)).toBeVisible();
  });

  await test.step("the new link activates", async () => {
    await page.goto(second);
    await expect(page.getByRole("heading", { name: "Account activated" })).toBeVisible();
  });
});

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });

/** The submit button is disabled until React hydrates; typing before that would be lost. */
async function hydrated(submit: Locator) {
  await expect(submit).toBeEnabled();
}

/** Tabs forward until `target` has focus, asserting a visible focus ring at every stop on the way. */
async function tabTo(page: Page, target: Locator, maxStops = 40) {
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached ${target}`);
}

async function typeInto(page: Page, field: Locator, text: string) {
  await tabTo(page, field);
  await page.keyboard.type(text);
}

async function replaceFocused(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

/**
 * The focused element draws a visible outline: every focus ring in the app is one (globals.css,
 * ModeSwitch). A box-shadow does not count, since a checked ModeSwitch label has one at rest. A
 * visually hidden radio draws its ring on its label instead (ModeSwitch), so that counts too; its
 * own outline, from the global rule, cannot be seen and does not.
 */
async function expectVisibleFocus(page: Page) {
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: true, what: "body" }; // between cycles
    const ring = (e: Element) => {
      const box = e.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const s = getComputedStyle(e);
      // Computed colours read rgba(r, g, b, 0) or color(… / 0) when fully transparent.
      const clear = /^rgba\(.*,\s*0\)$|\/\s*0\)$|^transparent$/.test(s.outlineColor);
      return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && !clear;
    };
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const what = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`;
    return { ok: ring(el) || (el.matches("input[type=radio]") && !!label && ring(label)), what };
  });
  expect(focus.ok, `no visible focus ring on ${focus.what}`).toBe(true);
}

/** Nothing scrolls sideways, and axe finds no critical or serious issue (contrast is rated serious). */
async function checkScreen(page: Page, testInfo: TestInfo, screen: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${screen} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  testInfo.annotations.push({
    type: "axe",
    description: `${screen}: ${blocking.length} critical or serious${
      blocking.length ? ` (${blocking.map((v) => v.id).join(", ")})` : ""
    }`,
  });
  expect(
    blocking.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    `critical or serious axe issues on ${screen}`,
  ).toEqual([]);
}
