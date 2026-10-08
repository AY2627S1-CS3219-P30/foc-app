import { describe, expect, it } from "bun:test";
import { dayRange, describeAlert, formatDuration, isUuid } from "../src/lib/admin-labels";
import { withAdminEntry, STUDENT_NAV } from "../src/lib/nav";

const ids = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002" };
const name = (id: unknown) => (id === ids.a ? "ana@u.nus.edu" : id === ids.b ? "ben@u.nus.edu" : "someone");

describe("describeAlert", () => {
  it("says whether a role change had a second administrator", () => {
    const base = { kind: "ROLE_CHANGE" as const, actorId: ids.a };
    expect(
      describeAlert({ ...base, details: { targetUserId: ids.b, role: "ADMIN", requestedBy: ids.b, approvedBy: ids.a } }, name),
    ).toBe("ana@u.nus.edu made ben@u.nus.edu an administrator, as ben@u.nus.edu asked.");
    expect(
      describeAlert({ ...base, details: { targetUserId: ids.b, role: "STUDENT", requestedBy: ids.a, approvedBy: ids.a } }, name),
    ).toBe(
      "ana@u.nus.edu removed ben@u.nus.edu's administrator role without a second administrator — nobody else held the role.",
    );
  });

  it("names who reactivated an administrator", () => {
    expect(
      describeAlert({ kind: "ADMIN_REACTIVATED", actorId: ids.a, details: { targetUserId: ids.b } }, name),
    ).toBe("ana@u.nus.edu reactivated the administrator ben@u.nus.edu.");
  });

  it("gives the counts behind a bulk alert, and tolerates missing ones", () => {
    expect(
      describeAlert({ kind: "BULK_READS", actorId: ids.a, details: { readsInLastHour: 50, threshold: 50 } }, name),
    ).toBe("ana@u.nus.edu opened 50 accounts within an hour (the alert is at 50).");
    expect(describeAlert({ kind: "SUSPENSION_LIMIT_REACHED", actorId: ids.a, details: {} }, name)).toBe(
      "ana@u.nus.edu reached the limit of ? suspensions an hour; further suspensions were refused.",
    );
  });
});

describe("dayRange", () => {
  it("spans whole days in the browser's time zone", () => {
    const { from, to } = dayRange("2026-10-01", "2026-10-02");
    expect(new Date(from!).getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(new Date(to!).getTime()).toBe(new Date(2026, 9, 2, 23, 59, 59, 999).getTime());
  });

  it("leaves out an empty or malformed end", () => {
    expect(dayRange("", "")).toEqual({ from: undefined, to: undefined });
    expect(dayRange("not-a-date", "")).toEqual({ from: undefined, to: undefined });
  });
});

describe("formatDuration", () => {
  it.each([
    [45_000, "45 s"],
    [12 * 60_000, "12 min"],
    [60 * 60_000, "1 h"],
    [185 * 60_000, "3 h 5 min"],
  ])("%p ms reads as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("isUuid", () => {
  it("accepts an account id in either case, and nothing else", () => {
    expect(isUuid(ids.a)).toBe(true);
    expect(isUuid(` ${ids.a.toUpperCase()} `)).toBe(true);
    expect(isUuid("ana@u.nus.edu")).toBe(false);
  });
});

describe("the admin console entry", () => {
  it("is added to the navigation for administrators only, once", () => {
    expect(withAdminEntry(STUDENT_NAV, ["STUDENT"])).toEqual(STUDENT_NAV);
    expect(withAdminEntry(STUDENT_NAV, undefined)).toEqual(STUDENT_NAV);
    const admin = withAdminEntry(STUDENT_NAV, ["STUDENT", "ADMIN"]);
    expect(admin.at(-1)).toEqual({ href: "/admin", label: "Admin console" });
    expect(withAdminEntry(admin, ["ADMIN"])).toHaveLength(admin.length);
  });
});
