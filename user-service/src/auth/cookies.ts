import type { Request, Response } from 'express';
import { ApiException } from '@foc/platform';

export const REFRESH_COOKIE = 'foc_refresh';
export const REFRESH_TTL_DAYS = 7;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name)
      return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * HttpOnly keeps the token out of JavaScript (XSS cannot read it), SameSite=Strict
 * stops the browser attaching it to cross-site requests (CSRF), and Path=/auth
 * means it is sent to the auth endpoints only. `Secure` is on in production; local
 * development runs over plain http, where Safari would otherwise drop the cookie.
 */
export function setRefreshCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/auth',
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/auth' });
}

/**
 * Extra CSRF defence for the two endpoints that accept the cookie. A browser
 * always sends `Origin` on a cross-site POST, so a foreign origin is refused;
 * and requiring a JSON content type rules out a plain HTML form post.
 */
export function assertCsrfSafe(req: Request, allowedOrigins: readonly string[]): void {
  const origin = req.header('origin');
  if (origin && !allowedOrigins.includes(origin)) {
    throw new ApiException(403, 'CSRF_REJECTED', 'Request origin is not allowed.');
  }
  if (!(req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new ApiException(403, 'CSRF_REJECTED', 'Content-Type must be application/json.');
  }
}
