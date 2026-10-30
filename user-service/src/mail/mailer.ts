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

export interface Mailer {
  sendActivation(email: ActivationEmail): Promise<void>;
}

export const MAILER = Symbol('MAILER');
