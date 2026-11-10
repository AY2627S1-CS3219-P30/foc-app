// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-30
// Scope: Generated the initial implementation for "serve the Chat Service's lookup" (NTH-02, #162).
// Author review: Zhang Yuan validated the behaviour and the implementation, checked for fatal
//   errors, and confirmed it does not conflict with the architecture before committing.

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiException } from '@foc/platform';

export const SERVICE_KEYS = Symbol('ORDER_SERVICE_KEYS');

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** The ADR 0004 X-Service-Key check, copied from the Credit Service, for Order's internal reads. */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
  private readonly digests: Buffer[];

  constructor(@Inject(SERVICE_KEYS) keys: string[]) {
    this.digests = keys.map(digest);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      header(name: string): string | undefined;
    }>();
    const header = request.header('x-service-key');
    if (header) {
      const presented = digest(header);
      const matches = this.digests
        .map((configured) => timingSafeEqual(configured, presented))
        .reduce((match, current) => match || current, false);
      if (matches) return true;
    }
    throw new ApiException(401, 'SERVICE_UNAUTHENTICATED', 'Invalid service credential.');
  }
}
