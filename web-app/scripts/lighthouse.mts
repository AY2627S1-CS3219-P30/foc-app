// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-03 to 2026-11-05
// Scope: Generated the initial implementation for "axe on every core screen, keyboard-only errand
//   journey, Lighthouse" (#166, #309); later tests and new features.
// Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
//   and conflicts with our architecture before committing.

/**
 * UI-NFR3.1.1 (#166): Lighthouse, mobile, three runs per core screen, against a running production
 * build of the web app. Run by ../scripts-lighthouse.sh, which starts that stack; with Node 24
 * (`node scripts/lighthouse.mts`), not Bun, which Lighthouse does not support.
 *
 * Each run is a Lighthouse user flow in a fresh Chromium profile, so the cache is cold:
 *   1. a navigation (Lighthouse's default mobile settings: emulated phone, simulated slow 4G and
 *      4x CPU slowdown) gives LCP, CLS and TBT;
 *   2. a timespan around real input on the loaded page (typing, a tap) gives INP, which a
 *      navigation cannot measure.
 * A screen behind sign-in gets the session the way a returning student has it: the refresh cookie,
 * from a sign-in through the API, set on the browser before the load. Lighthouse's storage reset is
 * off so the cookie survives; the fresh profile already starts with nothing cached.
 *
 * Writes every flow result and summary.json under LIGHTHOUSE_OUT, and prints the table.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { startFlow } from "lighthouse";
import puppeteer, { type Page } from "puppeteer-core";

const BASE = process.env.LIGHTHOUSE_BASE_URL ?? "http://localhost:3000";
const MAILPIT = process.env.LIGHTHOUSE_MAILPIT_URL ?? "http://localhost:8025";
const OUT = process.env.LIGHTHOUSE_OUT ?? join(process.cwd(), "../.lighthouse-results/latest");
const RUNS = Number(process.env.LIGHTHOUSE_RUNS ?? 3);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();
const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAINS ?? "u.nus.edu").split(",")[0].trim();
const PASSWORD = "a long enough passphrase";
const STAMP = Date.now();
const OPEN_ERRANDS = 5;

type Cookie = { name: string; value: string; path: string; secure: boolean; sameSite: "Strict" | "Lax" | "None" };
type Session = { token: string; cookie: Cookie };

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function ok(response: Response, what: string) {
  if (!response.ok) throw new Error(`${what}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function login(email: string, password = PASSWORD): Promise<Session> {
  const response = await call("/api/user/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const { accessToken } = await ok(response, `login ${email}`);
  const raw = response.headers.getSetCookie().find((c) => c.startsWith("foc_refresh="));
  if (!raw) throw new Error("The login set no refresh cookie.");
  const [pair, ...attributes] = raw.split(";").map((part) => part.trim());
  const attribute = (name: string) =>
    attributes.find((a) => a.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
  const sameSite = (attribute("samesite") ?? "Lax").toLowerCase();
  return {
    token: accessToken,
    cookie: {
      name: "foc_refresh",
      value: pair.slice("foc_refresh=".length),
      path: attribute("path") ?? "/",
      secure: attributes.some((a) => a.toLowerCase() === "secure"),
      sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
    },
  };
}

async function student(who: string): Promise<{ email: string; token: string }> {
  const email = `lighthouse-${who}-${STAMP}@${DOMAIN}`;
  await ok(
    await call("/api/user/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, displayName: `Lighthouse ${who}` }),
    }),
    `register ${email}`,
  );
  const token = await until("the activation email", async () => {
    const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`)).json();
    const id = search.messages?.[0]?.ID;
    if (!id) return undefined;
    const text: string = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()).Text;
    return text.match(/\/activate\?token=([\w-]+)/)?.[1];
  });
  // The password is chosen at activation (#309).
  await ok(
    await call("/api/user/auth/activate", { method: "POST", body: JSON.stringify({ token, password: PASSWORD }) }),
    "activate",
  );
  const { token: access } = await login(email);
  await until("the wallet", async () => ((await call("/api/credit/wallets/me", { token: access })).ok ? true : undefined));
  return { email, token: access };
}

/** The first configured administrator, its seed password changed once as the console requires. */
async function adminEmail(): Promise<{ email: string; password: string }> {
  const email = (process.env.ADMIN_SEED_EMAILS ?? "").split(",")[0].trim();
  const seed = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !seed) throw new Error("Set ADMIN_SEED_EMAILS and ADMIN_SEED_PASSWORD (scripts-lighthouse.sh reads .env).");
  const password = createHash("sha256").update(`${seed}:lighthouse`).digest("hex");
  const first = await call("/api/user/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (first.status === 401) {
    const initial = await call("/api/user/auth/login", { method: "POST", body: JSON.stringify({ email, password: seed }) });
    const body = await initial.json();
    if (body.error?.code !== "PASSWORD_CHANGE_REQUIRED") throw new Error(`Admin sign-in: ${JSON.stringify(body)}`);
    await ok(
      await call("/api/user/auth/password", {
        method: "POST",
        body: JSON.stringify({ email, currentPassword: seed, newPassword: password }),
      }),
      "admin password change",
    );
  } else await ok(first, "admin sign-in");
  return { email, password };
}

async function post(token: string, supplierId: string, item: string) {
  const created = await ok(
    await call("/api/order/orders", {
      method: "POST",
      token,
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({
        supplierId,
        items: [{ name: item, quantity: 1 }],
        deliveryZone: "PGP House 7",
        deliveryInstructions: "Leave it at the lobby counter.",
        reward: 1,
      }),
    }),
    "post an errand",
  );
  return until("the errand to open", async () => {
    const order = await ok(await call(`/api/order/orders/${created.orderId}`, { token }), "read errand");
    return order.status === "OPEN" ? (order as { orderId: string; version: number }) : undefined;
  });
}

async function command(token: string, orderId: string, name: string) {
  const order = await ok(await call(`/api/order/orders/${orderId}`, { token }), "read errand");
  return ok(
    await call(`/api/order/orders/${orderId}/${name}`, {
      method: "POST",
      token,
      body: JSON.stringify({ expectedVersion: order.version }),
    }),
    name,
  );
}

/** The seeded data: one errand complete (wallet and history have entries), one active, a few open. */
async function seed() {
  const requester = await student("requester");
  const courier = await student("courier");
  await ok(
    await call("/api/user/users/me", { method: "PATCH", token: courier.token, body: JSON.stringify({ preferredMode: "COURIER" }) }),
    "courier mode",
  );
  const suppliers = await ok(await call("/api/supplier/suppliers?pageSize=1", { token: requester.token }), "suppliers");
  const supplierId: string = suppliers.items[0].supplierId;
  const done = await post(requester.token, supplierId, "Lighthouse completed errand");
  for (const step of ["accept", "pickup", "deliver"]) await command(courier.token, done.orderId, step);
  await command(requester.token, done.orderId, "confirm-receipt");
  const active = await post(requester.token, supplierId, "Lighthouse active errand");
  await command(courier.token, active.orderId, "accept");
  for (let i = 1; i <= OPEN_ERRANDS; i++) await post(requester.token, supplierId, `Lighthouse open errand ${i}`);
  return { requester: requester.email, courier: courier.email, activeId: active.orderId };
}

type Screen = {
  name: string;
  path: string;
  as: "requester" | "courier" | "admin" | null;
  /** The input timed for INP, on the loaded page. */
  interact: (page: Page) => Promise<void>;
};

async function typeInto(page: Page, selector: string, text: string) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector);
  await page.keyboard.type(text, { delay: 50 });
}

async function openAndClose(page: Page, selector: string) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector);
  await new Promise((r) => setTimeout(r, 500));
  await page.keyboard.press("Escape");
}

function screens(activeId: string): Screen[] {
  return [
    { name: "Sign in", path: "/login", as: null, interact: (p) => typeInto(p, 'input[type="email"]', "student@u.nus.edu") },
    { name: "Feed (courier board)", path: "/feed", as: "courier", interact: (p) => typeInto(p, 'input[placeholder="e.g. COM2"]', "COM2") },
    { name: "Composer (pickup point)", path: "/request/new", as: "requester", interact: (p) => typeInto(p, 'input[type="search"]', "Printer") },
    { name: "Active errand (requester)", path: `/request/${activeId}`, as: "requester", interact: (p) => openAndClose(p, "xpath/.//button[normalize-space()='Cancel errand']") },
    { name: "Wallet", path: "/wallet", as: "requester", interact: (p) => openAndClose(p, 'button[aria-label="Open menu"]') },
    { name: "History", path: "/order-history", as: "requester", interact: (p) => openAndClose(p, 'button[aria-label="Open menu"]') },
    // The console has no phone app bar (it is DesktopShell at every width): type in its directory search.
    { name: "Admin console (users)", path: "/admin/users", as: "admin", interact: (p) => typeInto(p, 'input[type="search"]', "lighthouse") },
  ];
}

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

async function measure(screen: Screen, run: number, credentials: Record<string, { email: string; password: string }>) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    if (screen.as) {
      const { email, password } = credentials[screen.as];
      const { cookie } = await login(email, password);
      await browser.setCookie({ ...cookie, domain: new URL(BASE).hostname, httpOnly: true });
    }
    const page = await browser.newPage();
    const flow = await startFlow(page, { flags: { disableStorageReset: true } });
    await flow.navigate(`${BASE}${screen.path}`, { name: `${screen.name}: load` });
    await flow.startTimespan({ name: `${screen.name}: interaction` });
    await screen.interact(page);
    await new Promise((r) => setTimeout(r, 1_000));
    await flow.endTimespan();
    const result = await flow.createFlowResult();
    writeFileSync(join(OUT, `${screen.path.replace(/[^a-z0-9]+/gi, "_")}-run${run}.json`), JSON.stringify(result));
    const [load, span] = result.steps.map((s) => s.lhr);
    const audit = (lhr: typeof load, id: string) => lhr.audits[id]?.numericValue;
    if (screen.as && new URL(load.finalDisplayedUrl).pathname === "/login")
      throw new Error(`${screen.name} was not signed in: it landed on ${load.finalDisplayedUrl}`);
    return {
      lcp: audit(load, "largest-contentful-paint"),
      cls: audit(load, "cumulative-layout-shift"),
      tbt: audit(load, "total-blocking-time"),
      fcp: audit(load, "first-contentful-paint"),
      inp: audit(span, "interaction-to-next-paint"),
      spanTbt: audit(span, "total-blocking-time"),
      loadThrottling: load.configSettings.throttlingMethod,
      spanThrottling: span.configSettings.throttlingMethod,
      finalUrl: load.finalDisplayedUrl,
      lighthouse: load.lighthouseVersion,
      chrome: load.environment.hostUserAgent,
    };
  } finally {
    await browser.close();
  }
}

const data = await seed();
const admin = await adminEmail();
const credentials = {
  requester: { email: data.requester, password: PASSWORD },
  courier: { email: data.courier, password: PASSWORD },
  admin,
};
mkdirSync(OUT, { recursive: true });
const summary = [];
for (const screen of screens(data.activeId)) {
  const runs: Awaited<ReturnType<typeof measure>>[] = [];
  for (let run = 1; run <= RUNS; run++) runs.push(await measure(screen, run, credentials));
  const values = (key: "lcp" | "cls" | "tbt" | "inp") => runs.map((r) => r[key]).filter((v): v is number => v !== undefined);
  const row = {
    screen: screen.name,
    path: screen.path.replace(data.activeId, ":id"),
    runs,
    medianLcp: values("lcp").length === runs.length ? median(values("lcp")) : null,
    medianInp: values("inp").length === runs.length ? median(values("inp")) : null,
    medianTbt: median(values("tbt")),
    medianCls: median(values("cls")),
  };
  summary.push(row);
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ base: BASE, runs: RUNS, summary }, null, 2));
  const fmt = (xs: (number | undefined)[]) => xs.map((x) => (x === undefined ? "n/a" : Math.round(x))).join(" / ");
  process.stdout.write(
    `${row.screen} (${row.path}): LCP ${fmt(runs.map((r) => r.lcp))} ms, median ${row.medianLcp === null ? "n/a" : Math.round(row.medianLcp)}; ` +
      `INP ${fmt(runs.map((r) => r.inp))} ms, median ${row.medianInp ?? "n/a"}; ` +
      `TBT median ${Math.round(row.medianTbt)} ms; CLS median ${row.medianCls.toFixed(3)}\n`,
  );
}
process.stdout.write(`Wrote ${join(OUT, "summary.json")}\n`);
