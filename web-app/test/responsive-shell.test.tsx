import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const window = new Window({ url: "http://localhost:3000/feed" });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

mock.module("../src/lib/auth", () => ({
  useAuth: () => ({
    authed: <T,>(call: (token: string) => Promise<T>) => call("test-token"),
    user: { id: "me", roles: ["STUDENT"], profile: { displayName: "Alyssa", preferredMode: "REQUESTER" } },
    logout: () => {},
    setMode: () => {},
    modeSaving: false,
  }),
}));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/feed",
}));
// Other test files replace this module for the whole run. The query string asks for the real one,
// because this is the file that tests it.
const { ResponsiveShell } = await import("../src/components/ResponsiveShell.tsx?real");
const { StoreProvider } = await import("../src/lib/store");
const { CreditsProvider } = await import("../src/lib/credits");
const { STUDENT_NAV } = await import("../src/lib/nav");

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
});

async function render(props: Partial<Parameters<typeof ResponsiveShell>[0]>, children: ReactNode = <p>Page body</p>) {
  await act(async () =>
    root.render(
      <StoreProvider>
        <CreditsProvider enabled={false}>
          <ResponsiveShell title="Active requests" navItems={STUDENT_NAV} activeHref="/feed" {...props}>
            {children}
          </ResponsiveShell>
        </CreditsProvider>
      </StoreProvider>,
    ),
  );
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-label") === name || b.textContent === name,
  );

describe("the app frame is one tree at every width (#367)", () => {
  it("has one main and one heading, and renders the page once", async () => {
    await render({});
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("Active requests");
    expect(container.textContent!.match(/Page body/g)).toHaveLength(1);
    expect(container.querySelector("main")?.textContent).toContain("Page body");
  });

  it("names the page the same in the app bar and the heading", async () => {
    await render({});
    expect(container.querySelector("header")?.textContent).toContain("Active requests");
    expect(container.querySelector("h1")?.textContent).toBe("Active requests");
  });

  it("offers a primary action as the app bar's + and a button, and both do the same", async () => {
    let done = 0;
    await render({ primaryAction: { label: "New request", onClick: () => (done += 1) } });
    const [plus, full] = button("New request");
    expect(plus?.getAttribute("aria-label")).toBe("New request");
    // Icon only: the drawn + is decorative and the label names it.
    expect(plus?.textContent).toBe("");
    expect(plus?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(full?.textContent).toBe("New request");
    await act(async () => plus!.click());
    await act(async () => full!.click());
    expect(done).toBe(2);
  });

  it("offers neither without a primary action", async () => {
    await render({});
    expect(button("New request")).toEqual([]);
  });
});
