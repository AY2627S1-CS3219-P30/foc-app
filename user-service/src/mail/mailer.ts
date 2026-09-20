/**
 * The seam between the User Service and whatever delivers email. Production
 * would implement this with an SMTP or transactional-mail provider; only the
 * development mailbox exists today (see dev-mailbox.ts).
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
