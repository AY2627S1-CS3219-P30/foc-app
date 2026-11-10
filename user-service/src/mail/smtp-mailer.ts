// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-27 to 2026-11-05
// Scope: Generated the initial implementation for "real activation email, resend, and no token on
//   an open route" (USR-09, #309, USR-12); later new features and bug fixes.
// Author review: Anselm Long reviewed the implementation for correctness, ran it against the test
//   suite, and checked that it fits our service boundaries without fatal errors before committing.

import { createTransport, type Transporter } from 'nodemailer';
import type { ActivationEmail, Mailer, PasswordResetEmail } from './mailer.js';

export interface SmtpSettings {
  host: string;
  port: number;
  /** Both or neither. A local catcher (Mailpit) needs none; a real relay reads them from the secret store. */
  user?: string;
  password?: string;
  /**
   * Refuse to send unless the server upgrades with STARTTLS. Without it, someone on the path can
   * strip the upgrade and read the credential and the token. Only a local catcher may go without.
   */
  requireTls: boolean;
}

export interface ActivationMailSettings {
  from: string;
  /**
   * The web app's activation page. The token is appended as `?token=`. The password reset page is
   * its sibling `reset-password`, resolved against it, so one setting serves both links.
   */
  activationUrl: string;
}

/** Delivers activation and password reset email over SMTP: to Mailpit locally, or to a relay. */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly settings: ActivationMailSettings,
  ) {}

  static connect(smtp: SmtpSettings, settings: ActivationMailSettings): SmtpMailer {
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      // Implicit TLS on 465; any other port upgrades with STARTTLS when the server offers it.
      secure: smtp.port === 465,
      requireTLS: smtp.requireTls,
      // Registration waits for the send, so a dead relay must fail fast, not after minutes.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      // Nodemailer's own logger would print the message, and with it the token.
      logger: false,
      debug: false,
    });
    return new SmtpMailer(transport, settings);
  }

  async sendActivation(email: ActivationEmail): Promise<void> {
    const link = new URL(this.settings.activationUrl);
    link.searchParams.set('token', email.token);
    await this.transport.sendMail({
      from: this.settings.from,
      to: email.to,
      subject: 'Activate your Friend on Campus account',
      text: [
        'Open this link to choose your password and activate your Friend on Campus account:',
        '',
        link.href,
        '',
        `Or paste this code on the activation page: ${email.token}`,
        '',
        'The link works once and expires soon.',
        '',
        "If you didn't sign up, ignore this email and nothing will happen.",
      ].join('\n'),
    });
  }

  async sendPasswordReset(email: PasswordResetEmail): Promise<void> {
    // Resolved against the activation page without its trailing slash: `…/activate/` would otherwise
    // give `…/activate/reset-password`.
    const link = new URL('reset-password', this.settings.activationUrl.replace(/\/+$/, ''));
    link.searchParams.set('token', email.token);
    await this.transport.sendMail({
      from: this.settings.from,
      to: email.to,
      subject: 'Reset your Friend on Campus password',
      text: [
        'Open this link to choose a new password for your Friend on Campus account:',
        '',
        link.href,
        '',
        'The link works once and expires soon.',
        'Choosing a new password signs you out everywhere, and activates the account if it was still waiting for activation.',
        '',
        "If you didn't ask for this, ignore this email: your password stays as it is.",
      ].join('\n'),
    });
  }
}
