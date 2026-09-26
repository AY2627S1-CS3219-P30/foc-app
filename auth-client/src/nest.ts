import {
  CanActivate,
  createParamDecorator,
  DynamicModule,
  ExecutionContext,
  Inject,
  Injectable,
  Module,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import type { Request } from 'express';
import { createAuthenticator, type Authenticator } from './authenticator.js';
import { authFailure } from './errors.js';
import type { AuthConfig, AuthContext } from './types.js';

export const AUTHENTICATOR = Symbol('FOC_AUTHENTICATOR');
export type AuthedRequest = Request & { auth?: AuthContext };

/** Requires a valid, live, active session. Sets `request.auth`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTHENTICATOR) private readonly authenticator: Authenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.auth = await this.authenticator.authenticate(req.header('authorization'));
    return true;
  }
}

/** Requires the ADMIN role. Must run after {@link AuthGuard}; use `@AdminOnly()` to get both in order. */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  constructor(@Inject(AUTHENTICATOR) private readonly authenticator: Authenticator) {}

  canActivate(context: ExecutionContext): boolean {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    // No context means the guards are misordered. Fail closed, and as "unauthenticated".
    if (!auth) throw authFailure('TOKEN_MISSING');
    this.authenticator.requireAdmin(auth);
    return true;
  }
}

/** Any signed-in, active user. */
export const Authenticated = () => applyDecorators(UseGuards(AuthGuard));

/** Administrators only. Applies both guards in the right order. */
export const AdminOnly = () => applyDecorators(UseGuards(AuthGuard, AdminOnlyGuard));

/** The verified caller. Only available on a route protected by `@Authenticated()` or `@AdminOnly()`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw authFailure('TOKEN_MISSING');
    return auth;
  },
);

@Module({})
export class AuthModule {
  /** Import once in a service's root module. Guards then work anywhere in that service. */
  static forRoot(config: AuthConfig): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        { provide: AUTHENTICATOR, useValue: createAuthenticator(config) },
        AuthGuard,
        AdminOnlyGuard,
      ],
      exports: [AUTHENTICATOR, AuthGuard, AdminOnlyGuard],
    };
  }
}
