import { expect, test, type Page } from "@playwright/test";
import {
  activeStudent,
  compose,
  firstSupplier,
  ORDER,
  ORDER_URL,
  row,
  signIn,
  visible,
  wallet as readWallet,
} from "./request-helpers";

/**
 * WEB-04 end to end, once per breakpoint, against the real stack: a post whose response is lost,
 * or that is sent offline, never makes a second errand (UI-NFR4.1.2). After each case the API must
 * show exactly one more order, the one the page landed on, and the wallet must have reserved its
 * reward once.
 *
 * One student runs the four cases in turn, keeping sign-ups inside the rate limit. Rewards of 2, 2
 * and 1 leave 5 of the 10 starting credits, so the last case posts the whole balance.
 * Each case relies on the orders and wallet the earlier ones left, so debug the first failure.
 */

test("reconnect journey: a lost or offline post creates one errand", async ({
  page,
  context,
  request,
}, testInfo) => {
  const email = `e2e-reconnect-${testInfo.project.name}-${Date.now()}@u.nus.edu`;
  const token = await activeStudent(request, email);
  const supplier = await firstSupplier(request, token);
  const auth = { authorization: `Bearer ${token}` };
  const posted: string[] = [];
  let reserved = 0;

  const wallet = () => readWallet(request, token);
  const postedOnce = async (reward: number) => {
    await expect(page).toHaveURL(ORDER_URL);
    posted.push(new URL(page.url()).pathname.split("/").at(-1)!);
    reserved += reward;
    const mine = await (await request.get(`${ORDER}/orders/mine`, { headers: auth })).json();
    expect(mine.items.map((o: { orderId: string }) => o.orderId).sort()).toEqual([...posted].sort());
    await expect.poll(wallet, { timeout: 30_000 }).toMatchObject({ available: 10 - reserved, reserved });
  };

  await test.step("sign in", () => signIn(page, email));

  await test.step("response lost after the server got it: Try again finds the same errand", async () => {
    await compose(page, { supplier: supplier.name, item: "Kopi O", reward: 2 });
    const lost = await loseNextPost(page);
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
    const drafts = await page.evaluate(() => Object.keys(sessionStorage));
    expect(drafts.some((key) => key.startsWith("foc.request-draft:"))).toBe(true);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page).toHaveURL(new RegExp(`/request/${await lost.orderId}$`));
    await expect(visible(page, "This request was already posted")).toBeVisible();
    await postedOnce(2);
  });

  await test.step("offline, then back: the online listener retries and creates one errand", async () => {
    await compose(page, { supplier: supplier.name, item: "Kaya toast", reward: 2 });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    await context.setOffline(false);
    await postedOnce(2);
  });

  await test.step("lost response, then an edit: the stored body is replayed", async () => {
    await compose(page, { supplier: supplier.name, item: "Milo", reward: 1 });
    const lost = await loseNextPost(page);
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByRole("slider").fill("2");
    await page.getByRole("button", { name: "Review request" }).click();
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page.getByText("This request was already posted before your latest changes")).toBeVisible();

    await page.getByRole("button", { name: "View request" }).click();
    await expect(page).toHaveURL(new RegExp(`/request/${await lost.orderId}$`));
    await postedOnce(1);
  });

  await test.step("lost response, then a reload, for the whole balance: Post still finds it", async () => {
    await compose(page, { supplier: supplier.name, item: "Teh C", reward: 5 });
    await expect(row(page, "Available after reserving the reward")).toContainText("0 credits");
    const lost = await loseNextPost(page);
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect.poll(async () => (await wallet()).available, { timeout: 30_000 }).toBe(0);

    await page.reload();
    await expect(page.getByText("You have no credits available")).toBeVisible();
    await page.getByRole("button", { name: "Post request" }).click();
    await expect(page).toHaveURL(new RegExp(`/request/${await lost.orderId}$`));
    await postedOnce(5);
  });
});

/** Lets the next `POST /orders` reach the Order Service, then drops its response. */
async function loseNextPost(page: Page) {
  let lost = false;
  let created!: (orderId: string) => void;
  const orderId = new Promise<string>((resolve) => (created = resolve));
  await page.route(`${ORDER}/orders`, async (route) => {
    if (lost || route.request().method() !== "POST") return route.fallback();
    lost = true;
    created((await (await route.fetch()).json()).orderId);
    await route.abort();
  });
  return { orderId };
}
