/**
 * Client-side checks that mirror the User Service's rules, so an obvious mistake is caught before a
 * round trip. The server stays authoritative: its field errors are shown the same way.
 */

export type Errors = Partial<Record<string, string>>;

/** The registration policy (US-FR1.1.1, decisions.md S7): 12–128 characters, no composition rules. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | undefined {
  const v = email.trim();
  if (!v) return "Enter your NUS email address.";
  if (!EMAIL.test(v)) return "Enter a valid email address, like e0123456@u.nus.edu.";
  return undefined;
}

export function validateNewPassword(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return undefined;
}

export function validateDisplayName(name: string): string | undefined {
  const v = name.trim();
  if (!v) return "Enter the name other students will see.";
  if (v.length > 50) return "Use at most 50 characters.";
  return undefined;
}

export function validateRegistration(input: {
  email: string;
  displayName: string;
  password: string;
  confirm: string;
}): Errors {
  const errors: Errors = {
    email: validateEmail(input.email),
    displayName: validateDisplayName(input.displayName),
    password: validateNewPassword(input.password),
    confirm: input.confirm !== input.password ? "The passwords don't match." : undefined,
  };
  return compact(errors);
}

export function validateLogin(input: { email: string; password: string }): Errors {
  return compact({
    email: validateEmail(input.email),
    password: input.password ? undefined : "Enter your password.",
  });
}

export function validatePasswordChange(input: {
  email: string;
  currentPassword: string;
  newPassword: string;
  confirm: string;
}): Errors {
  return compact({
    email: validateEmail(input.email),
    currentPassword: input.currentPassword ? undefined : "Enter your current password.",
    newPassword:
      validateNewPassword(input.newPassword) ??
      (input.newPassword === input.currentPassword
        ? "Choose a password different from the current one."
        : undefined),
    confirm: input.confirm !== input.newPassword ? "The passwords don't match." : undefined,
  });
}

function compact(errors: Errors): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v !== undefined));
}

/**
 * Where to go after signing in. Only a same-site path is accepted, so a crafted `?next=` link cannot
 * bounce a freshly signed-in user to another site (open redirect).
 */
export function safeNext(next: string | null | undefined, fallback = "/feed"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
