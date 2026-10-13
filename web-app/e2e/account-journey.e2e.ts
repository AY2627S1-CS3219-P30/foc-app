import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * USR-05 acceptance criteria, end to end, once per breakpoint (see playwright.config.ts):
 * - the journey works at 360, 768 and 1440 px, with nothing scrolling sideways;
 * - a failed submit keeps what was typed and marks the offending field;
 * - sign-up, activation and sign-in are done by keyboard alone, and every focus stop is visible;
 * - axe reports no critical issue on any account screen;
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

  await test.step("a signed-out visitor is sent to sign in, and back afterwards", async () => {
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

  await test.step("activate from the dev mailbox link", async () => {
    await tabTo(page, page.getByRole("link", { name: "open the activation link" }));
    await page.keyboard.press("Enter");
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
    await page.keyboard.press("ArrowRight");
    await expect(to).toBeChecked();
    await expect(page.locator("fieldset[aria-busy=true]")).toHaveCount(0);

    await page.reload();
    await expect(to).toBeChecked();
  });

  await test.step("log out ends the session", async () => {
    await tabTo(page, page.getByRole("button", { name: "Log out" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);
  });
});

/** A form control by its accessible name; the visible label also carries the required marker. */
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
 * visually hidden radio draws its ring on its label instead (ModeSwitch), so that counts too.
 */
async function expectVisibleFocus(page: Page) {
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: true, what: "body" }; // between cycles
    const ring = (e: Element) => {
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

/** Nothing scrolls sideways, and axe finds no critical issue. Serious ones are reported, not failed. */
async function checkScreen(page: Page, testInfo: TestInfo, screen: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${screen} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);

  const { violations } = await new AxeBuilder({ page }).analyze();
  const critical = violations.filter((v) => v.impact === "critical");
  const serious = violations.filter((v) => v.impact === "serious");
  testInfo.annotations.push({
    type: "axe",
    description: `${screen}: ${critical.length} critical, ${serious.length} serious${
      serious.length ? ` (${serious.map((v) => v.id).join(", ")})` : ""
    }`,
  });
  expect(
    critical.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    `critical axe issues on ${screen}`,
  ).toEqual([]);
}
