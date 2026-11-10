// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Sonnet 5), dates: 2026-09-20 to 2026-11-05
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01, USR-02, USR-03); later new features and bug fixes.
// Author review: Anselm Long validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException } from '@foc/platform';
import { AccessTokenGuard, type AuthedRequest } from '../auth/access-token.guard.js';
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
import {
  activateSchema,
  changePasswordSchema,
  loginSchema,
  parseOrThrow,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  resendActivationSchema,
  stepUpSchema,
} from './validation.js';

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
    const { token, password } = parseOrThrow(activateSchema, body);
    return this.users.activate(token, password, correlationOf(req));
  }

  /**
   * The same 202 whatever the address: whether it has a pending account is not the caller's to
   * learn. Both limits count every request, known address or not, so a 429 reveals nothing; the
   * per-address one stops anyone filling a student's inbox. The work runs after the answer.
   */
  @Post('activation/resend')
  @HttpCode(202)
  resendActivation(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { message: string } {
    const { email } = parseOrThrow(resendActivationSchema, body);
    this.limit(res, this.limiters.resendPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.resendPerEmail, normalizeEmail(email));
    void this.users.resendActivation(email);
    return {
      message: 'If that address has an account waiting for activation, a new link is on its way.',
    };
  }

  /**
   * #309 — asks for a password reset link. Answered like resend, for the same reasons: the same 202
   * for any address, both limits counting every request, and the work done after the answer. Its
   * limits are its own, so resending an address's activation link cannot use up its resets.
   */
  @Post('password-reset')
  @HttpCode(202)
  requestPasswordReset(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { message: string } {
    const { email } = parseOrThrow(passwordResetRequestSchema, body);
    this.limit(res, this.limiters.resetPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.resetPerEmail, normalizeEmail(email));
    void this.users.requestPasswordReset(email);
    return {
      message: 'If that address has an account, a link to reset its password is on its way.',
    };
  }

  /**
   * Sets the password from a reset link. No cookie is read or set, so no origin check: the token in
   * the body is the credential, and a cross-site page cannot know it.
   */
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const { token, password } = parseOrThrow(passwordResetConfirmSchema, body);
    await this.sessions.confirmPasswordReset(token, password, correlationOf(req));
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Login sets the refresh cookie, so it needs the same origin check as refresh: otherwise
    // a hostile page could post the attacker's own credentials and silently sign the victim in
    // as the attacker (login CSRF / session fixation).
    assertCsrfSafe(req, this.cookies.allowedOrigins);
    const { email, password } = parseOrThrow(loginSchema, body);
    this.limit(res, this.limiters.loginPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.loginPerEmail, normalizeEmail(email));
    return this.withCookie(res, await this.sessions.login(email, password));
  }

  /**
   * Changes a password by proving the current one. It is a password oracle exactly like login,
   * so it shares login's per-IP and per-email limits and its origin check.
   */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertCsrfSafe(req, this.cookies.allowedOrigins);
    const { email, currentPassword, newPassword } = parseOrThrow(changePasswordSchema, body);
    this.limit(res, this.limiters.loginPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.loginPerEmail, normalizeEmail(email));
    await this.sessions.changePassword(email, currentPassword, newPassword);
  }

  /**
   * Re-enter the password on the current session (ADR 0008): the riskiest admin actions need it
   * within the last few minutes. Bearer-authenticated, so no cookie and no CSRF exposure. Limited
   * like login, because it answers whether a password is right.
   */
  @Post('step-up')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async stepUp(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { password } = parseOrThrow(stepUpSchema, body);
    this.limit(res, this.limiters.loginPerIp, req.ip ?? 'unknown');
    this.limit(res, this.limiters.stepUpPerUser, req.auth.userId);
    await this.sessions.stepUp(req.auth.userId, req.auth.sessionId, password);
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
