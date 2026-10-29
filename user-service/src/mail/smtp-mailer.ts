import { createTransport, type Transporter } from 'nodemailer';
import type { ActivationEmail, Mailer } from './mailer.js';

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
  /** The web app's activation page. The token is appended as `?token=`. */
  activationUrl: string;
}

/** Delivers activation email over SMTP: to Mailpit in the local stack, or to a relay. */
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
        'Open this link to activate your Friend on Campus account:',
        '',
        link.href,
        '',
        `Or paste this code on the activation page: ${email.token}`,
        '',
        "If you didn't sign up, ignore this email and nothing will happen.",
      ].join('\n'),
    });
  }
}
