// AI Assistance Disclosure:
// Tool: Claude Code (Claude Sonnet 5), date: 2026-09-20
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01).
// Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
//   and conflicts with our architecture before committing.

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ApiException } from '@foc/platform';
import { sha256Hex } from './tokens.js';

export const SERVICE_KEYS = Symbol('SERVICE_KEYS');

/**
 * Guards /internal/**. Only a caller presenting a configured `X-Service-Key`
 * gets through; a user's access token is not an accepted credential here, so a
 * student cannot read another user's identity record by calling this directly.
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
  private readonly digests: Buffer[];

  constructor(@Inject(SERVICE_KEYS) keys: string[]) {
    // Compare fixed-length digests so neither key length nor content leaks through timing.
    this.digests = keys.map((k) => Buffer.from(sha256Hex(k), 'hex'));
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().header('x-service-key');
    if (header) {
      const presented = Buffer.from(sha256Hex(header), 'hex');
      // Check every key without short-circuiting.
      const match = this.digests
        .map((d) => timingSafeEqual(d, presented))
        .reduce((a, b) => a || b, false);
      if (match) return true;
    }
    throw new ApiException(401, 'SERVICE_UNAUTHENTICATED', 'Invalid service credential.');
  }
}
