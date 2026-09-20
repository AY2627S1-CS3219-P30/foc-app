import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { ActivationEmail, Mailer } from './mailer.js';

/**
 * Development stand-in for a mail provider. It keeps messages in memory so a
 * developer, a test or the demo can read the activation token that would
 * otherwise arrive by email. It is refused in production (see users.module.ts),
 * because exposing a token to anyone who can read this mailbox defeats activation.
 */
export class DevMailbox implements Mailer {
  private readonly messages: ActivationEmail[] = [];

  async sendActivation(email: ActivationEmail): Promise<void> {
    this.messages.push(email);
  }

  latestFor(to: string): ActivationEmail | undefined {
    return [...this.messages].reverse().find((m) => m.to === to.trim().toLowerCase());
  }
}

/** `GET /dev/mailbox?to=<email>` — mounted only outside production. Not part of the public contract. */
@Controller('dev/mailbox')
export class DevMailboxController {
  constructor(@Inject(DevMailbox) private readonly mailbox: DevMailbox) {}

  @Get()
  read(@Query('to') to?: string): { to: string; token: string } | { message: string } {
    const found = to ? this.mailbox.latestFor(to) : undefined;
    return found ? { to: found.to, token: found.token } : { message: 'No message.' };
  }
}
