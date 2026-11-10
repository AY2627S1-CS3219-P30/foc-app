import { afterAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import type { OrderStatus } from "../src/lib/order-api";
import type { Role } from "../src/lib/order-actions";

// react-dom decides whether it can use the DOM when first imported, so the globals come first.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ErrandProgress } = await import("../src/components/ErrandProgress");

afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

async function mount(status: OrderStatus, role: Role = "COURIER", reward = 3) {
  const container = window.document.createElement("div");
  window.document.body.replaceChildren(container);
  const root = createRoot(container as unknown as Element);
  const show = (next: OrderStatus) =>
    act(async () => root.render(<ErrandProgress status={next} reward={reward} role={role} />));
  await show(status);
  const track = () => container.querySelector('[aria-label="Errand progress"]') as HTMLElement | null;
  return { container, track, rerender: show, unmount: () => act(async () => root.unmount()) };
}

describe("errand progress track", () => {
  it("draws a track for each status on the usual route, and nothing for those that leave it", async () => {
    const onRoute: OrderStatus[] = [
      "PENDING_CREDIT",
      "OPEN",
      "ACCEPTED",
      "PICKED_UP",
      "DELIVERED",
      "COMPLETION_PENDING_CREDIT",
      "COMPLETED",
    ];
    const offRoute: OrderStatus[] = ["DISPUTED", "RELEASE_PENDING_CREDIT", "REJECTED", "CANCELLED", "EXPIRED"];
    for (const status of onRoute) {
      const { track, unmount } = await mount(status);
      expect(track()?.querySelectorAll("li")).toHaveLength(5);
      expect(track()?.getAttribute("role")).toBe("list");
      await unmount();
    }
    for (const status of offRoute) {
      const { container, unmount } = await mount(status);
      expect(container.innerHTML).toBe("");
      await unmount();
    }
  });

  it("marks the stop the errand has reached as the current step", async () => {
    const expected: [OrderStatus, string][] = [
      ["PENDING_CREDIT", "Posted"],
      ["OPEN", "Posted"],
      ["ACCEPTED", "Accepted"],
      ["PICKED_UP", "In transit"],
      ["DELIVERED", "Delivered"],
      ["COMPLETION_PENDING_CREDIT", "Delivered"],
    ];
    for (const [status, stop] of expected) {
      const { track, unmount } = await mount(status);
      const current = track()!.querySelectorAll('[aria-current="step"]');
      expect(current).toHaveLength(1);
      expect(current[0].textContent).toBe(stop);
      await unmount();
    }
  });

  it("has no current step once complete, with every stop done", async () => {
    const { track, unmount } = await mount("COMPLETED");
    expect(track()!.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
    expect(Array.from(track()!.querySelectorAll("li"), (li) => li.getAttribute("data-state"))).toEqual(
      Array(5).fill("done"),
    );
    await unmount();
  });

  it("shows the reward on the last stop to the courier only", async () => {
    const courier = await mount("COMPLETED", "COURIER", 4);
    expect(courier.track()!.textContent).toContain("+4 credits to you");
    await courier.unmount();

    const requester = await mount("COMPLETED", "REQUESTER", 4);
    expect(requester.track()!.textContent).not.toContain("+4");
    await requester.unmount();

    const notYet = await mount("DELIVERED", "COURIER", 4);
    expect(notYet.track()!.textContent).not.toContain("+4");
    await notYet.unmount();
  });

  it("celebrates a completion that happens while the page is open, not one it opened on", async () => {
    const live = await mount("DELIVERED");
    expect(live.track()!.hasAttribute("data-arrived")).toBe(false);
    await live.rerender("COMPLETED");
    expect(live.track()!.hasAttribute("data-arrived")).toBe(true);
    await live.unmount();

    const opened = await mount("COMPLETED");
    expect(opened.track()!.hasAttribute("data-arrived")).toBe(false);
    expect(opened.track()!.hasAttribute("data-complete")).toBe(true);
    await opened.unmount();
  });
});
