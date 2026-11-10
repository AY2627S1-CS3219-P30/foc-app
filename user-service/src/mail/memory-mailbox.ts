// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-27 to 2026-11-03
// Scope: Generated the initial implementation for "real activation email, resend, and no token on
//   an open route" (USR-09, #309); later new features.
// Author review: Anselm Long checked the code for correctness against the ticket, confirmed the
//   tests pass, and made sure it caused no fatal errors or architectural conflicts before
//   committing.

import type { ActivationEmail, Mailer, PasswordResetEmail } from './mailer.js';

/**
 * Keeps messages in memory instead of sending them. The test suites read activation and reset tokens
 * from it, and a developer running the service without SMTP configured gets it too, with a warning
 * at boot. No route exposes it: production refuses to start without SMTP (see users.module.ts).
 */
export class MemoryMailbox implements Mailer {
  private readonly messages: ActivationEmail[] = [];
  private readonly resets: PasswordResetEmail[] = [];

  async sendActivation(email: ActivationEmail): Promise<void> {
    this.messages.push(email);
  }

  async sendPasswordReset(email: PasswordResetEmail): Promise<void> {
    this.resets.push(email);
  }

  /** The newest activation email to this address. */
  latestFor(to: string): ActivationEmail | undefined {
    return latest(this.messages, to);
  }

  /** The newest password reset email to this address. */
  latestResetFor(to: string): PasswordResetEmail | undefined {
    return latest(this.resets, to);
  }
}

const latest = <T extends { to: string }>(messages: T[], to: string): T | undefined =>
  [...messages].reverse().find((m) => m.to === to.trim().toLowerCase());
