import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiException } from '@foc/platform';

export const SERVICE_KEYS = Symbol('CREDIT_SERVICE_KEYS');

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Reuses the repository's ADR-0004 X-Service-Key trust mechanism for Credit internal reads. */
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
