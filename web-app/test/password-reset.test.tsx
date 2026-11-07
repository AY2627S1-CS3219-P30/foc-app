import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

// One object each, so they keep their identity across renders like the real hooks'.
const router = { push: () => {}, replace: () => {} };
const auth = { login: async () => {}, status: "signedOut", logoutPending: false, retryLogout: async () => true };
// With useSearchParams too: Bun keeps a module mock for the whole run, so a file that runs after this
// one and imports it from next/navigation would otherwise fail to load.
mock.module("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("../src/lib/auth", () => ({ useAuth: () => auth }));
const { default: ForgotPasswordPage } = await import("../src/app/forgot-password/page");
const { default: ResetPasswordPage } = await import("../src/app/reset-password/page");
const { default: LoginPage } = await import("../src/app/login/page");
const { default: RegisterPage } = await import("../src/app/register/page");
const { default: ActivatePage } = await import("../src/app/activate/page");

const TOKEN = "a".repeat(43);
const NEUTRAL = "If e0123456@u.nus.edu has an account, we've emailed it a link to reset its password.";

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const error = (status: number, code: string, message = "Refused.", details: unknown[] = []) =>
  json(status, { error: { code, message, correlationId: "c-1", details } });

/** A fake User Service: answers every call with `reply`, and records what was sent. */
let sent: { path: string; body: unknown }[] = [];
function serve(reply: () => Response) {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    sent.push({ path: new URL(request.url).pathname, body: await request.json().catch(() => null) });
    return reply();
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  sent = [];
  container = document.createElement("div") as unknown as HTMLElement;
  document.body.replaceChildren(container as never);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"])
    delete (globalThis as Record<string, unknown>)[key];
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
async function render(page: React.ReactElement, url: string) {
  window.happyDOM.setURL(`http://localhost:3000${url}`);
  await act(async () => root.render(page));
  await settle();
}
/** The control a label names; a required field's label ends in a decorative " *". */
const field = (label: string) => {
  const target = [...container.querySelectorAll("label")].find(
    (l) => l.textContent?.replace(/ \*$/, "") === label,
  )!;
  return document.getElementById(target.htmlFor) as unknown as HTMLInputElement;
};
const type = (label: string, value: string) =>
  act(() => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();
}
const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
const statuses = () => [...container.querySelectorAll('[role="status"]')].map((a) => a.textContent).join(" ");
const links = () => [...container.querySelectorAll("a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href") }));

describe("forgot password", () => {
  it("asks for a link and shows the same neutral message whatever the address", async () => {
    serve(() => json(202, { message: "If that address has an account, a link to reset its password is on its way." }));
    await render(<ForgotPasswordPage />, "/forgot-password");

    await type("NUS email", " e0123456@u.nus.edu ");
    await submit();

    expect(sent).toEqual([{ path: "/auth/password-reset", body: { email: "e0123456@u.nus.edu" } }]);
    expect(container.querySelector("h1")?.textContent).toBe("Check your email");
    expect(statuses()).toContain(NEUTRAL);
    expect(container.querySelector("form")?.hidden).toBe(true);
  });

  it("checks the address before asking, and marks the field", async () => {
    serve(() => json(202, { message: "x" }));
    await render(<ForgotPasswordPage />, "/forgot-password");

    await type("NUS email", "not-an-email");
    await submit();

    expect(sent).toEqual([]);
    expect(field("NUS email").getAttribute("aria-invalid")).toBe("true");
  });

  it("says when there have been too many requests", async () => {
    serve(() => error(429, "RATE_LIMITED", "Too many attempts. Try again later."));
    await render(<ForgotPasswordPage />, "/forgot-password");

    await type("NUS email", "e0123456@u.nus.edu");
    await submit();

    expect(alerts()).toContain("Too many requests for a reset link.");
    expect(statuses()).not.toContain(NEUTRAL);
  });

  it("starts with the address sign-up passed along", async () => {
    await render(<ForgotPasswordPage />, "/forgot-password?email=e0123456%40u.nus.edu");
    expect(field("NUS email").value).toBe("e0123456@u.nus.edu");
  });
});

describe("reset password", () => {
  it("sets the new password from the link's token, then leads to sign-in", async () => {
    serve(() => json(204));
    await render(<ResetPasswordPage />, `/reset-password?token=${TOKEN}`);

    await type("New password", "a long enough passphrase");
    await type("Confirm new password", "a long enough passphrase");
    await submit();

    expect(sent).toEqual([
      { path: "/auth/password-reset/confirm", body: { token: TOKEN, password: "a long enough passphrase" } },
    ]);
    expect(container.querySelector("h1")?.textContent).toBe("Password changed");
    expect(statuses()).toContain("Your new password is set.");
    expect(links()).toContainEqual({ text: "Sign in", href: "/login" });
  });

  it("applies the sign-up password rules before sending anything", async () => {
    serve(() => json(204));
    await render(<ResetPasswordPage />, `/reset-password?token=${TOKEN}`);

    await type("New password", "too short");
    await type("Confirm new password", "something else");
    await submit();

    expect(sent).toEqual([]);
    expect(field("New password").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Use at least 12 characters.");
    expect(field("Confirm new password").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("The passwords don't match.");
    // What was typed is kept.
    expect(field("New password").value).toBe("too short");
  });

  it("explains an invalid or used link and offers a new one, keeping the form", async () => {
    serve(() => error(404, "PASSWORD_RESET_TOKEN_INVALID", "This password reset link is not valid."));
    await render(<ResetPasswordPage />, `/reset-password?token=${TOKEN}`);

    await type("New password", "a long enough passphrase");
    await type("Confirm new password", "a long enough passphrase");
    await submit();

    expect(alerts()).toContain("This reset link isn't valid.");
    expect(links()).toContainEqual({ text: "Ask for a new link", href: "/forgot-password" });
    expect(container.querySelector("h1")?.textContent).toBe("Choose a new password");
    expect(field("New password").value).toBe("a long enough passphrase");
  });

  it("explains an expired link", async () => {
    serve(() => error(410, "PASSWORD_RESET_TOKEN_EXPIRED", "This password reset link has expired."));
    await render(<ResetPasswordPage />, `/reset-password?token=${TOKEN}`);

    await type("New password", "a long enough passphrase");
    await type("Confirm new password", "a long enough passphrase");
    await submit();

    expect(alerts()).toContain("This reset link has expired.");
  });

  it("shows the service's field errors on the fields", async () => {
    serve(() =>
      error(422, "VALIDATION_FAILED", "One or more fields are invalid.", [
        { field: "password", code: "PASSWORD_UNCHANGED", message: "Choose a password different from the bootstrap password." },
      ]),
    );
    await render(<ResetPasswordPage />, `/reset-password?token=${TOKEN}`);

    await type("New password", "a long enough passphrase");
    await type("Confirm new password", "a long enough passphrase");
    await submit();

    expect(alerts()).toContain("Check the highlighted fields.");
    expect(field("New password").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Choose a password different from the bootstrap password.");
  });

  it("without a token, says to use the emailed link and sends nothing", async () => {
    serve(() => json(204));
    await render(<ResetPasswordPage />, "/reset-password");

    expect(alerts()).toContain("Open this page from the link in your password reset email");
    expect(links()).toContainEqual({ text: "ask for a new link", href: "/forgot-password" });
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe("the way to a reset", () => {
  it("is linked from sign-in", async () => {
    await render(<LoginPage />, "/login");
    expect(links()).toContainEqual({ text: "Forgot your password?", href: "/forgot-password" });
  });

  it("a refused sign-in also points a new student to activation, saying nothing about the address", async () => {
    const { ApiError } = await import("../src/lib/user-api");
    const login = auth.login;
    // What a pending account gets (#309), and exactly what any wrong password gets.
    auth.login = async () => {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    };
    try {
      await render(<LoginPage />, "/login");
      await type("NUS email", "e0123456@u.nus.edu");
      await type("Password", "a long enough passphrase");
      await submit();

      expect(alerts()).toContain("That email and password don't match an account.");
      expect(alerts()).toContain("Just signed up? Open the activation email to choose your password.");
      expect(links()).toContainEqual({ text: "choose your password", href: "/activate" });
    } finally {
      auth.login = login;
    }
  });

  it("is offered when sign-up finds the address taken, with the address", async () => {
    serve(() => error(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists."));
    await render(<RegisterPage />, "/register");

    await type("NUS email", "e0123456@u.nus.edu");
    await type("Display name", "Alex Tan");
    await submit();

    expect(field("NUS email").getAttribute("aria-invalid")).toBe("true");
    expect(alerts()).toContain("This email already has an account.");
    expect(links()).toContainEqual({
      text: "reset the password",
      href: "/forgot-password?email=e0123456%40u.nus.edu",
    });
  });

  it("is offered when a used activation link is opened again", async () => {
    serve(() => json(200, { userId: "u-1", status: "ACTIVE", alreadyActivated: true }));
    await render(<ActivatePage />, `/activate?token=${TOKEN}`);
    await type("Password", "a long enough passphrase");
    await type("Confirm password", "a long enough passphrase");
    await submit();

    expect(statuses()).toContain("its password hasn't changed");
    expect(links()).toContainEqual({ text: "Reset it", href: "/forgot-password" });
  });

  it("is not offered while the activation link is still unused", async () => {
    await render(<ActivatePage />, "/activate");
    expect(links().map((l) => l.href)).not.toContain("/forgot-password");
  });
});

describe("sign-up (#309)", () => {
  it("asks for no password: it is chosen at activation", async () => {
    serve(() => json(201, { userId: "u-1", status: "PENDING_ACTIVATION" }));
    await render(<RegisterPage />, "/register");
    expect(container.querySelector('input[type="password"]')).toBeNull();

    await type("NUS email", " e0123456@u.nus.edu ");
    await type("Display name", "Alex Tan");
    await submit();

    expect(sent).toEqual([
      { path: "/auth/register", body: { email: "e0123456@u.nus.edu", displayName: "Alex Tan" } },
    ]);
    expect(statuses()).toContain("choose your password");
  });
});

describe("activation (#309)", () => {
  it("opening the link activates nothing until the student chooses a password", async () => {
    serve(() => json(200, { userId: "u-1", status: "ACTIVE", alreadyActivated: false }));
    await render(<ActivatePage />, `/activate?token=${TOKEN}`);

    expect(sent).toEqual([]);
    expect(container.querySelector('input[name="token"]')).toBeNull();
    await type("Password", "a long enough passphrase");
    await type("Confirm password", "a long enough passphrase");
    await submit();

    expect(sent).toEqual([
      { path: "/auth/activate", body: { token: TOKEN, password: "a long enough passphrase" } },
    ]);
    expect(container.querySelector("h1")?.textContent).toBe("Account activated");
    expect(statuses()).toContain("Your account is active.");
    expect(links()).toContainEqual({ text: "Sign in", href: "/login" });
  });

  it("applies the password rules before sending anything", async () => {
    serve(() => json(200, {}));
    await render(<ActivatePage />, `/activate?token=${TOKEN}`);
    await type("Password", "too short");
    await type("Confirm password", "something else");
    await submit();

    expect(sent).toEqual([]);
    expect(container.textContent).toContain("Use at least 12 characters.");
    expect(container.textContent).toContain("The passwords don't match.");
  });

  it("takes a pasted code with the password when opened without a link", async () => {
    serve(() => json(200, { userId: "u-1", status: "ACTIVE", alreadyActivated: false }));
    await render(<ActivatePage />, "/activate");

    await type("Password", "a long enough passphrase");
    await type("Confirm password", "a long enough passphrase");
    await submit();
    expect(sent).toEqual([]);
    expect(field("Activation code").getAttribute("aria-invalid")).toBe("true");

    await type("Activation code", ` ${TOKEN} `);
    await submit();
    expect(sent).toEqual([
      { path: "/auth/activate", body: { token: TOKEN, password: "a long enough passphrase" } },
    ]);
  });

  it("after the link's token is refused, takes the code from a newer email", async () => {
    const NEWER = "b".repeat(43);
    const replies = [
      () => error(404, "ACTIVATION_TOKEN_INVALID", "This activation link is not valid."),
      () => json(200, { userId: "u-1", status: "ACTIVE", alreadyActivated: false }),
    ];
    serve(() => replies.shift()!());
    await render(<ActivatePage />, `/activate?token=${TOKEN}`);
    await type("Password", "a long enough passphrase");
    await type("Confirm password", "a long enough passphrase");
    await submit();

    expect(alerts()).toContain("This activation link isn't valid.");
    expect(field("Activation code")).toBeDefined();
    expect(field("Password").value).toBe("a long enough passphrase");

    await type("Activation code", NEWER);
    await submit();
    expect(sent.map((s) => s.body)).toEqual([
      { token: TOKEN, password: "a long enough passphrase" },
      { token: NEWER, password: "a long enough passphrase" },
    ]);
    expect(statuses()).toContain("Your account is active.");
  });

  it("explains an expired link and keeps the typed password", async () => {
    serve(() => error(410, "ACTIVATION_TOKEN_EXPIRED", "This activation link has expired."));
    await render(<ActivatePage />, `/activate?token=${TOKEN}`);
    await type("Password", "a long enough passphrase");
    await type("Confirm password", "a long enough passphrase");
    await submit();

    expect(alerts()).toContain("This activation link has expired.");
    expect(field("Password").value).toBe("a long enough passphrase");
  });
});
