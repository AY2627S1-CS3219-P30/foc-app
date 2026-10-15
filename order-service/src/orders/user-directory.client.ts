import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../config.js';

export const USER_DIRECTORY_FETCH = Symbol('USER_DIRECTORY_FETCH');

const adminsSchema = z.object({ items: z.array(z.object({ userId: z.string().min(1) })) });

export class UserDirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserDirectoryUnavailableError';
  }
}

/**
 * Asks the User Service — the only source of account status and roles — who may act as an
 * administrator, with this service's own key. Any failure (unreachable, non-200, unexpected body)
 * is UserDirectoryUnavailableError, never a guess: the caller tries again on its next run.
 */
@Injectable()
export class UserDirectoryClient {
  constructor(@Inject(USER_DIRECTORY_FETCH) private readonly fetchFn: typeof fetch) {}

  /** The user IDs of every active administrator. */
  async listAdmins(): Promise<string[]> {
    let response: Response;
    try {
      response = await this.fetchFn(new URL('/internal/admins', env.USER_SERVICE_URL), {
        headers: { 'X-Service-Key': env.INTERNAL_SERVICE_KEY },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new UserDirectoryUnavailableError(`User Service unreachable: ${String(error)}`);
    }
    if (!response.ok) {
      throw new UserDirectoryUnavailableError(`User Service answered ${response.status}`);
    }
    const parsed = adminsSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new UserDirectoryUnavailableError('User Service body did not match the contract');
    }
    return parsed.data.items.map((item) => item.userId);
  }
}
