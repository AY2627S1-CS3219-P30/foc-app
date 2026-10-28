import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrandHistory } from "../src/components/ErrandHistory";
import type { OrderHistory } from "../src/lib/order-api";

const entry = (changes: Partial<OrderHistory["entries"][number]> = {}) => ({
  previousStatus: "DISPUTED",
  newStatus: "RELEASE_PENDING_CREDIT",
  action: "RESOLVE_FOR_REQUESTER",
  actorType: "ADMIN",
  actorId: "private-admin-id",
  reason: "Delivery was not received.",
  version: 8,
  occurredAt: "2026-10-28T06:00:00Z",
  ...changes,
});
const render = (entries: OrderHistory["entries"]) =>
  renderToStaticMarkup(
    <ErrandHistory history={{ orderId: "example-order", entries }} error={null} retry={() => {}} />,
  );

describe("participant errand history (WEB-06)", () => {
  it("shows a requester decision, its reason and actual decision time", () => {
    const html = render([entry()]);
    expect(html).toContain("Decided for the requester");
    expect(html).toContain("Delivery was not received.");
    expect(html).toContain('dateTime="2026-10-28T06:00:00Z"');
    expect(html).toContain("View status history");
    expect(html).not.toContain("private-admin-id");
  });
  it("shows a courier decision without interpreting a terminal status as a decision", () => {
    const html = render([
      entry({
        action: "RESOLVE_FOR_COURIER",
        newStatus: "COMPLETION_PENDING_CREDIT",
        reason: "The delivery evidence was accepted.",
      }),
      entry({
        action: "TRANSFER_CONFIRMED",
        newStatus: "COMPLETED",
        actorType: "CREDIT_SERVICE",
        reason: null,
        version: 9,
      }),
    ]);
    expect(html).toContain("Decided for the courier");
    expect(html).toContain("The delivery evidence was accepted.");
    expect(html).toContain("Complete");
    expect(render([entry({ action: "CANCEL", actorType: "REQUESTER", reason: null })])).not.toContain(
      "Decided for",
    );
  });
  it("never renders system causes or actor IDs and treats the reason as text", () => {
    const html = render([
      entry({
        actorType: "SYSTEM",
        action: "SYSTEM_OUTCOME",
        reason: "private suspension cause",
        version: 7,
      }),
      entry({ reason: '<img src=x onerror="alert(1)">' }),
    ]);
    expect(html).not.toContain("private suspension cause");
    expect(html).not.toContain("SYSTEM_OUTCOME");
    expect(html).not.toContain("private-admin-id");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  it("distinguishes a failed read, a loading read and an empty recorded history", () => {
    expect(
      renderToStaticMarkup(<ErrandHistory history={null} error="History unavailable" retry={() => {}} />),
    ).toContain("Could not load errand history");
    expect(renderToStaticMarkup(<ErrandHistory history={null} error={null} retry={() => {}} />)).toContain(
      "Loading errand history",
    );
    expect(render([])).toContain("No status changes recorded yet.");
  });
});
