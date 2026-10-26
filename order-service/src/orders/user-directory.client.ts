import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../config.js';

export const USER_DIRECTORY_FETCH = Symbol('USER_DIRECTORY_FETCH');

/**
 * How many messages each consumer that asks this client while holding a row lock (reservation
 * replies, suspensions) handles at once. Each holds a pool connection for up to the 5 s timeout
 * below, so the two together hold at most 6 of the pool's 10 and leave the rest for requests.
 */
export const LOCK_THEN_ASK_PREFETCH = 3;

const adminsSchema = z.object({ items: z.array(z.object({ userId: z.string().min(1) })) });
const lookupSchema = z.object({
  exists: z.boolean(),
  status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED']).optional(),
});

export class UserDirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserDirectoryUnavailableError';
  }
}

/**
 * Asks the User Service — the only source of account status and roles — who may act as an
 * administrator and whether a user is suspended, with this service's own key. Any failure
 * (unreachable, non-200, unexpected body) is UserDirectoryUnavailableError, never a guess: the
 * caller tries again later.
 */
@Injectable()
export class UserDirectoryClient {
  constructor(@Inject(USER_DIRECTORY_FETCH) private readonly fetchFn: typeof fetch) {}

  /** The user IDs of every active administrator. */
  async listAdmins(): Promise<string[]> {
    const body = await this.get('/internal/admins', adminsSchema);
    return body.items.map((item) => item.userId);
  }

  /** Whether the account is suspended now. An unknown user is not. */
  async isSuspended(userId: string): Promise<boolean> {
    const body = await this.get(`/internal/users/${encodeURIComponent(userId)}`, lookupSchema);
    return body.exists && body.status === 'SUSPENDED';
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, env.USER_SERVICE_URL), {
        headers: { 'X-Service-Key': env.INTERNAL_SERVICE_KEY },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new UserDirectoryUnavailableError(`User Service unreachable: ${String(error)}`);
    }
    if (!response.ok) {
      throw new UserDirectoryUnavailableError(`User Service answered ${response.status}`);
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new UserDirectoryUnavailableError('User Service body did not match the contract');
    }
    return parsed.data;
  }
}
