import { expect, type Locator, type Page } from "@playwright/test";

/** Tabs forward until `target` has focus, asserting a visible focus ring at every stop on the way. */
export async function tabTo(page: Page, target: Locator, maxStops = 40) {
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached ${target}`);
}

export async function typeInto(page: Page, field: Locator, text: string) {
  await tabTo(page, field);
  await page.keyboard.type(text);
}

export async function replaceFocused(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

/**
 * The focused element draws a visible outline: every focus ring in the app is one (globals.css,
 * ModeSwitch). A box-shadow does not count, since a checked ModeSwitch label has one at rest. A
 * visually hidden radio draws its ring on its label instead (ModeSwitch), so that counts too; its
 * own outline, from the global rule, cannot be seen and does not.
 */
export async function expectVisibleFocus(page: Page) {
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
