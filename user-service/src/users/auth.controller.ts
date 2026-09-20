import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException } from '@foc/platform';
import {
  assertCsrfSafe,
  clearRefreshCookie,
  readCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from '../auth/cookies.js';
import { RATE_LIMITERS, type AuthRateLimiters, type RateLimiter } from '../auth/rate-limiter.js';
import { SessionsService, type IssuedSession } from '../auth/sessions.service.js';
import { normalizeEmail } from './email.js';
import { UsersService } from './users.service.js';
import { activateSchema, loginSchema, parseOrThrow, registerSchema } from './validation.js';

export const AUTH_COOKIE_SETTINGS = Symbol('AUTH_COOKIE_SETTINGS');
export interface AuthCookieSettings {
  secure: boolean;
  allowedOrigins: readonly string[];
}

const correlationOf = (req: Request): string =>
  (req as Request & { correlationId?: string }).correlationId ?? 'unknown';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(RATE_LIMITERS) private readonly limiters: AuthRateLimiters,
    @Inject(AUTH_COOKIE_SETTINGS) private readonly cookies: AuthCookieSettings,
  ) {}

  @Post('register')
  @HttpCode(201)
  register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.limit(res, this.limiters.registerPerIp, req.ip ?? 'unknown');
    return this.users.register(parseOrThrow(registerSchema, body));
  }

  @Post('activate')
  @HttpCode(200)
  activate(@Body() body: unknown, @Req() req: Request) {
    const { token } = parseOrThrow(activateSchema, body);
    return this.users.activate(token, correlationOf(req));
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, password } = parseOrThrow(loginSchema, body);
    this.limit(res, this.limiters.loginPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.loginPerEmail, normalizeEmail(email));
    return this.withCookie(res, await this.sessions.login(email, password));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertCsrfSafe(req, this.cookies.allowedOrigins);
    const token = readCookie(req.header('cookie'), REFRESH_COOKIE);
    try {
      return this.withCookie(res, await this.sessions.refresh(token));
    } catch (err) {
      // A dead session must not leave a dead cookie in the browser.
      if (err instanceof ApiException && err.getStatus() === 401) {
        clearRefreshCookie(res, this.cookies.secure);
      }
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertCsrfSafe(req, this.cookies.allowedOrigins);
    await this.sessions.logout(readCookie(req.header('cookie'), REFRESH_COOKIE));
    clearRefreshCookie(res, this.cookies.secure);
  }

  private limit(res: Response, limiter: RateLimiter, key: string): void {
    const result = limiter.hit(key);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new ApiException(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
    }
  }

  /** The refresh token travels only in the HttpOnly cookie, never in the response body. */
  private withCookie(res: Response, issued: IssuedSession): Omit<IssuedSession, 'refreshToken'> {
    const { refreshToken, ...body } = issued;
    setRefreshCookie(res, refreshToken, this.cookies.secure);
    return body;
  }
}
