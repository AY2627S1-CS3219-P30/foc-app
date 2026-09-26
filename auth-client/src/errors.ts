import { ApiException } from '@foc/platform';

/**
 * Every way authentication or authorisation can fail, each with its own stable code so a
 * client (and a log reader) can tell them apart. All travel in the shared error envelope.
 */
export type AuthFailure =
  | 'TOKEN_MISSING' //         no Authorization header
  | 'TOKEN_MALFORMED' //       present, but not a Bearer JWT at all
  | 'TOKEN_INVALID' //         a JWT, but the signature, issuer or key is wrong
  | 'TOKEN_EXPIRED' //         a genuine token past its expiry: refresh and retry
  | 'TOKEN_REVOKED' //         a genuine, unexpired token whose session has ended (logout, suspension)
  | 'ACCOUNT_SUSPENDED' //     valid session, suspended account
  | 'ACCOUNT_NOT_ACTIVATED' // valid session, account not yet activated
  | 'FORBIDDEN' //             authenticated, but lacks the role (e.g. admin-only route)
  | 'IDENTITY_UNAVAILABLE'; // could not verify: the User Service or its keys are unreachable

const DETAILS: Record<AuthFailure, { status: number; message: string }> = {
  TOKEN_MISSING: { status: 401, message: 'Authentication required.' },
  TOKEN_MALFORMED: { status: 401, message: 'The access token is not well formed.' },
  TOKEN_INVALID: { status: 401, message: 'The access token is not valid.' },
  TOKEN_EXPIRED: { status: 401, message: 'The access token has expired. Refresh and retry.' },
  TOKEN_REVOKED: { status: 401, message: 'This session has ended. Log in again.' },
  ACCOUNT_SUSPENDED: { status: 403, message: 'This account is suspended.' },
  ACCOUNT_NOT_ACTIVATED: { status: 403, message: 'Activate your account first.' },
  FORBIDDEN: { status: 403, message: 'Administrator role required.' },
  // 503, not 401: a healthy user with a good token must not be told their token is bad
  // just because the User Service is down. Callers fail closed.
  IDENTITY_UNAVAILABLE: {
    status: 503,
    message: 'Could not verify your identity. Try again shortly.',
  },
};

export function authFailure(code: AuthFailure): ApiException {
  const { status, message } = DETAILS[code];
  return new ApiException(status, code, message);
}
