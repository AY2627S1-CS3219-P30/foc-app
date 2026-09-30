import { describe, expect, it } from "bun:test";
import {
  safeNext,
  validateLogin,
  validatePasswordChange,
  validateRegistration,
} from "../src/lib/validation";
import { ApiError, toApiError } from "../src/lib/user-api";
import { orderForMode } from "../src/lib/nav";

describe("registration validation mirrors the User Service", () => {
  const ok = {
    email: "e0123456@u.nus.edu",
    displayName: "Alex",
    password: "correct-horse-battery",
    confirm: "correct-horse-battery",
  };

  it("accepts a valid form", () => {
    expect(validateRegistration(ok)).toEqual({});
  });

  it("names every offending field, and only those", () => {
    const errors = validateRegistration({ email: "nope", displayName: " ", password: "short", confirm: "x" });
    expect(Object.keys(errors).sort()).toEqual(["confirm", "displayName", "email", "password"]);
  });

  it("uses the 12–128 character policy with no composition rules", () => {
    expect(validateRegistration({ ...ok, password: "a".repeat(11), confirm: "a".repeat(11) }).password).toBeDefined();
    expect(validateRegistration({ ...ok, password: "a".repeat(12), confirm: "a".repeat(12) })).toEqual({});
    expect(validateRegistration({ ...ok, password: "a".repeat(129), confirm: "a".repeat(129) }).password).toBeDefined();
  });
});

describe("login and password-change validation", () => {
  it("requires both login fields", () => {
    expect(Object.keys(validateLogin({ email: "", password: "" })).sort()).toEqual(["email", "password"]);
  });

  it("refuses a new password equal to the current one, as the server does", () => {
    const same = "correct-horse-battery";
    expect(
      validatePasswordChange({ email: "a@u.nus.edu", currentPassword: same, newPassword: same, confirm: same })
        .newPassword,
    ).toBeDefined();
  });
});

describe("safeNext never redirects off-site", () => {
  it.each([
    ["/profile", "/profile"],
    ["/request/abc?x=1", "/request/abc?x=1"],
    ["//evil.example", "/feed"],
    ["/\\evil.example", "/feed"],
    ["https://evil.example", "/feed"],
    ["javascript:alert(1)", "/feed"],
    [null, "/feed"],
    [undefined, "/feed"],
  ])("%p → %p", (input, expected) => {
    expect(safeNext(input as string | null | undefined)).toBe(expected);
  });
});

describe("toApiError reads the shared error envelope", () => {
  it("keeps code, message and per-field details", () => {
    const err = toApiError(422, {
      error: {
        code: "VALIDATION_FAILED",
        message: "One or more fields are invalid.",
        correlationId: "c",
        details: [{ field: "email", code: "EMAIL_DOMAIN_NOT_ALLOWED", message: "Use your NUS email address." }],
      },
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.fieldMessage("email")).toBe("Use your NUS email address.");
  });

  it("survives a body that is not the envelope", () => {
    expect(toApiError(502, "<html>bad gateway</html>").code).toBe("INTERNAL");
    expect(toApiError(400, null).code).toBe("ERROR");
    expect(toApiError(422, { error: { code: "X", details: [{ nope: 1 }] } }).details).toEqual([]);
  });
});

describe("orderForMode", () => {
  const items = [{ href: "/feed" }, { href: "/suppliers" }, { href: "/order-history" }];

  it("leads with the mode's screen and keeps every screen", () => {
    expect(orderForMode(items, "REQUESTER").map((i) => i.href)).toEqual(["/order-history", "/feed", "/suppliers"]);
    expect(orderForMode(items, "COURIER").map((i) => i.href)).toEqual(["/feed", "/suppliers", "/order-history"]);
    expect(orderForMode(items)).toBe(items);
  });
});
