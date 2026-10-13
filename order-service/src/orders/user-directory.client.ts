import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../config.js';

export const USER_DIRECTORY_FETCH = Symbol('USER_DIRECTORY_FETCH');

const adminsSchema = z.object({ items: z.array(z.object({ userId: z.string() })) });
const permissionsSchema = z.object({ userId: z.string(), isAdmin: z.boolean() });

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
    const body = await this.get('/internal/admins', adminsSchema);
    return body.items.map((item) => item.userId);
  }

  /** Whether the user may act as an administrator right now (false once suspended or demoted). */
  async permissions(userId: string): Promise<{ isAdmin: boolean }> {
    const body = await this.get(
      `/internal/users/${encodeURIComponent(userId)}/permissions`,
      permissionsSchema,
    );
    if (body.userId !== userId) {
      throw new UserDirectoryUnavailableError('User Service answered for a different user');
    }
    return { isAdmin: body.isAdmin };
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${env.USER_SERVICE_URL}${path}`, {
        headers: { 'X-Service-Key': env.INTERNAL_SERVICE_KEY },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new UserDirectoryUnavailableError(`User Service unreachable: ${String(error)}`);
    }
    if (!response.ok) {
      throw new UserDirectoryUnavailableError(
        `User Service answered ${response.status} for ${path}`,
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new UserDirectoryUnavailableError(
        `User Service body for ${path} did not match the contract`,
      );
    }
    return parsed.data;
  }
}
