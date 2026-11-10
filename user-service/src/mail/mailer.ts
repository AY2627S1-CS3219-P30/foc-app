// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Sonnet 5), dates: 2026-09-20 to 2026-11-03
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01, USR-09, #309); later new features.
// Author review: Anselm Long validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

/**
 * The seam between the User Service and whatever delivers email: SMTP
 * (smtp-mailer.ts), or an in-memory mailbox for tests (memory-mailbox.ts).
 */
export interface ActivationEmail {
  to: string;
  userId: string;
  /** The raw one-time token. Must reach the user and nowhere else — never log it. */
  token: string;
}

/** A password reset link (#309): the same shape, and the same rule about the token. */
export type PasswordResetEmail = ActivationEmail;

export interface Mailer {
  sendActivation(email: ActivationEmail): Promise<void>;
  sendPasswordReset(email: PasswordResetEmail): Promise<void>;
}

export const MAILER = Symbol('MAILER');
