import type { ActivationEmail, Mailer } from './mailer.js';

/**
 * Keeps messages in memory instead of sending them. The test suites read activation tokens from it,
 * and a developer running the service without SMTP configured gets it too, with a warning at boot.
 * No route exposes it: production refuses to start without SMTP (see users.module.ts).
 */
export class MemoryMailbox implements Mailer {
  private readonly messages: ActivationEmail[] = [];

  async sendActivation(email: ActivationEmail): Promise<void> {
    this.messages.push(email);
  }

  latestFor(to: string): ActivationEmail | undefined {
    return [...this.messages].reverse().find((m) => m.to === to.trim().toLowerCase());
  }
}
