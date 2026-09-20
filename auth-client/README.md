# @foc/auth-client

Shared auth middleware. **No service writes its own token parsing** — this package verifies an
access token, asks the User Service who is behind it, and hands your handler a typed caller.

It answers D2's "how does the User Service integrate with the other services?":

```
client ──Bearer JWT──▶ your service ──▶ @foc/auth-client
                                            │ 1. verify signature / issuer / expiry   (public JWKS, cached)
                                            │ 2. GET /internal/introspect?sid&sub     (X-Service-Key, cached ≤ 5 s)
                                            ▼
                                   AuthContext { userId, roles, status, isAdmin, … }
```

The role and status always come from step 2 — **never** from the token, a header, or the body.

## Use it (Nest)

**1. Add the dependency and the two variables.**

```jsonc
// <your-service>/package.json
"dependencies": { "@foc/auth-client": "*", "@foc/platform": "*" }
```

```ts
// <your-service>/src/config.ts
import { authEnvSchema, authConfigFromEnv } from '@foc/auth-client';
export const env = loadEnv({ ...authEnvSchema /*, your own variables */ });
export const authConfig = authConfigFromEnv(env);
```

```yaml
# compose.yaml — under your service's environment
USER_SERVICE_URL: http://user-service:3001
INTERNAL_SERVICE_KEY: ${SUPPLIER_INTERNAL_KEY} # one of the User Service's INTERNAL_SERVICE_KEYS
```

**2. Import the module once.**

```ts
// <your-service>/src/app.module.ts
@Module({ imports: [PlatformModule.forRoot({...}), AuthModule.forRoot(authConfig)] })
export class AppModule {}
```

**3. Decorate routes.**

```ts
import { AdminOnly, Authenticated, CurrentUser, type AuthContext } from '@foc/auth-client';

@Controller('suppliers')
export class SuppliersController {
  @Get()
  @Authenticated()                                   // any signed-in, active user
  list(@CurrentUser() user: AuthContext) { … }

  @Post()
  @AdminOnly()                                       // admins only (applies both guards, in order)
  create(@CurrentUser() user: AuthContext) { … }
}
```

**4. Dockerfile.** The image build copies only the manifests it needs, so add the package beside `platform`
in **both** the `deps` and `runtime` stages, and build it before your service:

```dockerfile
COPY auth-client/package.json auth-client/package.json          # deps + runtime stages
COPY auth-client auth-client                                    # build stage
RUN npm run build -w @foc/platform && npm run build -w @foc/auth-client && npm run build -w @foc/<your-service>
COPY --from=build /app/auth-client/dist auth-client/dist        # runtime stage
```

Outside Nest, call `createAuthenticator(config).authenticate(req.headers.authorization)` directly.

## What the caller gets

```ts
interface AuthContext {
  userId: string;
  sessionId: string;
  displayName: string;
  roles: readonly ('STUDENT' | 'ADMIN')[];
  status: 'ACTIVE'; // only ACTIVE accounts get this far
  isAdmin: boolean;
}
```

## Failure modes — each has its own code, in the shared error envelope

`{ "error": { "code", "message", "correlationId" } }`

| Code                    |  HTTP   | Meaning                                                           | Client should           |
| ----------------------- | :-----: | ----------------------------------------------------------------- | ----------------------- |
| `TOKEN_MISSING`         |   401   | No `Authorization` header                                         | Sign in                 |
| `TOKEN_MALFORMED`       |   401   | Present, but not a Bearer JWT                                     | Treat as a bug          |
| `TOKEN_INVALID`         |   401   | Bad signature, wrong issuer, unknown key, no session id           | Sign in                 |
| `TOKEN_EXPIRED`         |   401   | A genuine token past its 15 minutes                               | **Refresh, then retry** |
| `TOKEN_REVOKED`         |   401   | Genuine and unexpired, but the session ended (logout, suspension) | Sign in                 |
| `ACCOUNT_SUSPENDED`     |   403   | Live session, suspended account                                   | Show the reason         |
| `ACCOUNT_NOT_ACTIVATED` |   403   | Live session, account not activated                               | Prompt to activate      |
| `FORBIDDEN`             |   403   | Signed in, but not an admin                                       | —                       |
| `IDENTITY_UNAVAILABLE`  | **503** | Could not verify: the User Service or its keys are unreachable    | Retry shortly           |

**Forward compatible.** If the User Service later adds an account status or a role, consumers do not break: any status
other than exactly `ACTIVE` is denied as `ACCOUNT_NOT_ACTIVATED` (403), and an unknown role is ignored (it grants
nothing). Only a reply that is not an introspection at all is treated as an outage.

`IDENTITY_UNAVAILABLE` is deliberately **503, not 401**: a healthy user with a good token must not be told their
token is bad because the User Service had a bad moment. The package **fails closed** — it never grants access
it could not verify — so a User Service outage makes protected routes unavailable, not open.

## The staleness window (read this before relying on it)

The identity answer is cached per session for `cacheTtlMs` (**default 5 000 ms**). So:

- a **logout**, **suspension** or **role change** at the User Service is enforced here within **at most 5 s**,
  and takes effect immediately for any request that misses the cache;
- inside the window a just-suspended user's token still works. That is the bounded, documented trade for not
  making the User Service a per-request bottleneck. It is well inside USR-07's 10 s requirement;
- set `cacheTtlMs: 0` on a route-critical service to check every request (one extra small call each);
- concurrent requests for one session share a single call, and failures are **never cached**, so a recovered
  User Service is used at once.

USR-07 will additionally consume `UserSuspended` / `UserReactivated` to drop cache entries immediately, shrinking
the window for suspensions to the event's latency.

## Key rotation

Keys come from `GET /.well-known/jwks.json` and are cached. A token naming an unknown key triggers a refetch
(rate-limited, `jwksCooldownMs`, default 10 s), so rotating the User Service's signing key needs no redeploy.

## Configuration

| Option            | Default |                                           |
| ----------------- | ------- | ----------------------------------------- |
| `userServiceUrl`  | —       | Base URL of the User Service              |
| `serviceKey`      | —       | Sent as `X-Service-Key` on `/internal/**` |
| `cacheTtlMs`      | `5000`  | The staleness window; `0` = no caching    |
| `timeoutMs`       | `2000`  | Then fail closed                          |
| `maxCacheEntries` | `10000` | Oldest evicted first                      |
| `jwksCooldownMs`  | `10000` | Min gap between unknown-key refetches     |

## Tests

`npm test -w @foc/auth-client` — 48 tests, three layers:

- `authenticator.test.ts` — every failure code, the cache and its window, fail-closed behaviour, key rotation, against a fake User Service that speaks the real wire protocol.
- `nest-guards.test.ts` — a Supplier-style controller: student refused / admin accepted, the error envelope, header-claimed roles ignored.
- `integration.test.ts` — the same controller against the **real User Service** over HTTP: real logins, logout, suspension and demotion propagate to the other service.
