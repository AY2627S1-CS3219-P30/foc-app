import { expect, test, type Locator, type Page } from "@playwright/test";
import { badge, readOrder, student, waitStatus } from "./release-helpers";
import { ORDER, ORDER_URL, compose, firstSupplier, releaseEmail, signIn } from "./request-helpers";

/**
 * UI-NFR1.1.1 and UI-NFR1.1.2 (#374), on the screens UI-NFR1.1.1 names, against the real stack.
 *
 * At every breakpoint: no sideways page scroll, and no control cut off. On a phone as well: every
 * control is at least 44 by 44 CSS px, and the screen's primary next action can be seen without the
 * app bar covering it. Every screen is measured before anything is asserted, so one run names every
 * failure.
 *
 * In the release suite, on its own stack: it signs in twice per width, and the smoke suite is close
 * to the real limit of 50 sign-ins per address.
 */
const MIN_TARGET = 44;
const PHONE_WIDTH = 480;

type Finding = { screen: string; problem: string };

/** Measured by what a tap lands on: a checkbox or a radio takes its whole label. */
async function measure(page: Page) {
  return page.evaluate((minTarget) => {
    const selector = [
      "a[href]",
      "button",
      'input:not([type="hidden"])',
      "select",
      "textarea",
      "summary",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="switch"]',
    ].join(",");
    const describe = (el: Element) => {
      const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ");
      const fallback = el.getAttribute("placeholder") ?? el.getAttribute("name") ?? el.getAttribute("type") ?? "";
      return `<${el.tagName.toLowerCase()}> "${(text || fallback).slice(0, 40)}"`;
    };
    const target = (el: Element) => {
      const input = el as HTMLInputElement;
      if (el.tagName === "INPUT" && ["checkbox", "radio"].includes(input.type)) return input.labels?.[0] ?? el;
      return el;
    };
    const hides = (overflow: string) => overflow === "hidden" || overflow === "clip";
    /** Whether a parent that hides its overflow cuts this box off. */
    const cutOffByParent = (el: Element, box: DOMRect) => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(up);
        const outer = up.getBoundingClientRect();
        if (hides(overflowX) && (box.left < outer.left - 0.5 || box.right > outer.right + 0.5)) return true;
        if (hides(overflowY) && (box.top < outer.top - 0.5 || box.bottom > outer.bottom + 0.5)) return true;
      }
      return false;
    };
    const small: string[] = [];
    const clipped: string[] = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const box = target(el).getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
      // Half a pixel of rounding, so a 44 px control scaled to 43.99 is not a failure.
      if (box.width < minTarget - 0.5 || box.height < minTarget - 0.5) small.push(`${describe(el)} is ${size}`);
      const offPage = box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5;
      if (offPage) clipped.push(`${describe(el)} runs off the page`);
      else if (cutOffByParent(el, box)) clipped.push(`${describe(el)} is cut off by a parent`);
      const { overflowX } = getComputedStyle(el);
      if (["BUTTON", "A"].includes(el.tagName) && overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1)
        clipped.push(`${describe(el)} cuts off its label`);
    }
    // The page's own width can't show this: a modal dialog's overflow is auto, so what runs past its
    // edge scrolls inside it and the page stays narrow. No core screen is meant to scroll sideways.
    for (const el of document.body.querySelectorAll("*")) {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || !el.checkVisibility()) continue;
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1)
        clipped.push(`${describe(el)} scrolls sideways by ${el.scrollWidth - el.clientWidth}px`);
    }
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small,
      clipped,
    };
  }, MIN_TARGET);
}

/** Whether the action, once scrolled to, is what a tap in its middle would hit. */
async function covered(action: Locator) {
  return action.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const fixed = [...document.querySelectorAll("*")].filter((other) => {
      const { position } = getComputedStyle(other);
      return (position === "fixed" || position === "sticky") && !other.contains(el) && other.checkVisibility();
    });
    const overlapping = fixed.filter((other) => {
      const bar = other.getBoundingClientRect();
      return bar.bottom > box.top && bar.top < box.bottom && bar.right > box.left && bar.left < box.right;
    });
    if (overlapping.length) return `overlaps fixed navigation at ${Math.round(box.top)}px`;
    if (box.bottom > innerHeight || box.top < 0) return "is out of view after scrolling to it";
    return hit && (el === hit || el.contains(hit) || hit.contains(el)) ? null : "is covered by another element";
  });
}

async function check(page: Page, screen: string, findings: Finding[], primary?: Locator) {
  const { overflow, small, clipped } = await measure(page);
  const add = (problem: string) => findings.push({ screen, problem });
  if (overflow > 0) add(`the page scrolls sideways by ${overflow}px`);
  clipped.forEach(add);
  if ((page.viewportSize()?.width ?? 0) > PHONE_WIDTH) return;
  small.forEach(add);
  if (primary) {
    const problem = await covered(primary);
    if (problem) add(`the primary action ${problem}`);
  }
}

const shown = (page: Page, role: "button" | "link", name: string | RegExp) =>
  page.getByRole(role, { name, exact: typeof name === "string" }).filter({ visible: true }).first();

test.describe("mobile layout @release", () => {
  test.skip(process.env.E2E_RELEASE !== "1", "Run on the dedicated clean release stack with E2E_RELEASE=1.");
  test.describe.configure({ timeout: 120_000 });

  test("mobile layout: tap targets, primary actions and no sideways scroll on every core screen", async ({
    browser,
    page,
  }, testInfo) => {
    const findings: Finding[] = [];

    await page.goto("/login");
    const signInButton = shown(page, "button", "Sign in");
    await expect(signInButton).toBeVisible();
    await check(page, "sign in", findings, signInButton);

    await page.goto("/register");
    const createAccount = shown(page, "button", "Create account");
    await expect(createAccount).toBeVisible();
    await check(page, "registration", findings, createAccount);

    // The page an activation link opens: a password form, which activates nothing until sent (#309).
    await page.goto(`/activate?token=${"a".repeat(43)}`);
    const activate = shown(page, "button", "Activate account");
    await expect(activate).toBeVisible();
    await check(page, "activation", findings, activate);

    const token = await signIn(page.request, releaseEmail("requester"));
    const auth = { authorization: `Bearer ${token}` };

    await page.goto("/suppliers");
    await expect(page.locator("article").first()).toBeVisible();
    await check(page, "supplier search", findings, page.getByRole("searchbox", { name: "Search suppliers" }));
    const filters = page.getByRole("button", { name: "Filters and sort" });
    if (await filters.isVisible()) {
      await filters.click();
      await check(page, "supplier search: filters open", findings);
    }
    const card = page.locator("article").first();
    await card.getByRole("button", { name: "View details" }).click();
    await expect(card.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
    await check(page, "supplier search: card expanded", findings);

    const supplier = await firstSupplier(page.request, token);
    await page.goto("/request/new");
    const pick = page.getByRole("button", { name: supplier.name });
    await expect(pick).toBeVisible();
    await check(page, "request creation: pickup point", findings, pick);
    await page.goto(`/request/new/details?supplierId=${supplier.supplierId}`);
    const reviewButton = shown(page, "button", "Review request");
    await expect(reviewButton).toBeVisible();
    await check(page, "request creation: details", findings, reviewButton);

    await compose(page, { supplier: supplier.name, item: `Layout ${testInfo.project.name} ${Date.now()}`, reward: 1 });
    const post = shown(page, "button", "Post request");
    await expect(post).toBeEnabled();
    await check(page, "request creation: review", findings, post);
    await post.click();
    await expect(page).toHaveURL(ORDER_URL);
    const orderId = new URL(page.url()).pathname.split("/").pop()!;

    await badge(page, "Open");
    await check(page, "active order: requester", findings, shown(page, "button", /^Cancel/));

    await page.goto("/feed");
    const newRequest = shown(page, "button", "New request");
    await expect(newRequest).toBeVisible();
    await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
    await check(page, "open errands: requester", findings, newRequest);

    await page.goto("/wallet");
    await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByText("Available", { exact: false }).filter({ visible: true }).first()).toBeVisible();
    await check(page, "wallet", findings);

    const courier = await student(browser, page, "courier");
    await courier.goto("/feed");
    const acceptCard = shown(courier, "button", /^Accept errand from /);
    await expect(acceptCard).toBeVisible();
    await expect(courier.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0);
    await check(courier, "open errands: courier", findings, acceptCard);

    await courier.goto(`/request/${orderId}`);
    const accept = shown(courier, "button", "Accept errand");
    await expect(accept).toBeVisible();
    await check(courier, "active order: courier, open", findings, accept);
    await accept.click();
    const dialog = courier.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await check(courier, "active order: confirm dialog", findings, dialog.getByRole("button", { name: "Accept", exact: true }));
    await dialog.getByRole("button", { name: "Accept", exact: true }).click();
    const pickup = shown(courier, "button", "I've picked it up");
    await expect(pickup).toBeVisible();
    await check(courier, "active order: courier, accepted", findings, pickup);

    // The requester's credit back, and settled, so the next spec reads a steady wallet.
    const { version } = await readOrder(page, token, orderId);
    const cancelled = await page.request.post(`${ORDER}/orders/${orderId}/cancel`, {
      headers: auth,
      data: { expectedVersion: version },
    });
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    await waitStatus(page, token, orderId, "CANCELLED");
    await courier.context().close();

    await testInfo.attach("layout-findings.json", {
      body: JSON.stringify(findings, null, 2),
      contentType: "application/json",
    });
    expect(findings.map((f) => `${f.screen}: ${f.problem}`)).toEqual([]);
  });
});
