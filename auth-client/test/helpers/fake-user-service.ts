import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

export const SERVICE_KEY = 'fake-service-key-0123456789';

export interface FakeSession {
  userId: string;
  active: boolean;
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';
  roles: string[];
  displayName: string;
}

type Keys = { privateKey: CryptoKey; publicJwk: Record<string, unknown>; kid: string };

async function newKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, publicJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' }, kid };
}

/**
 * A stand-in for the User Service that speaks the real wire protocol — a JWKS endpoint and
 * `/internal/introspect` over HTTP — with knobs to make it slow, broken or stale.
 */
export async function startFakeUserService() {
  let keys = await newKeys();
  const sessions = new Map<string, FakeSession>();
  const stats = { jwksCalls: 0, introspectCalls: 0 };
  const behaviour = {
    introspectStatus: 200,
    introspectDelayMs: 0,
    jwksStatus: 200,
    garbageBody: false,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/jwks.json') {
      stats.jwksCalls++;
      return behaviour.jwksStatus === 200
        ? send(200, { keys: [keys.publicJwk] })
        : send(behaviour.jwksStatus, { error: 'down' });
    }

    if (url.pathname === '/internal/introspect') {
      stats.introspectCalls++;
      if (req.headers['x-service-key'] !== SERVICE_KEY) return send(401, { error: 'bad key' });
      const respond = () => {
        if (behaviour.introspectStatus !== 200)
          return send(behaviour.introspectStatus, { error: 'boom' });
        if (behaviour.garbageBody) return send(200, '{"active":"yes","roles":"ADMIN"}');
        const s = sessions.get(url.searchParams.get('sid') ?? '');
        if (!s || !s.active || s.userId !== url.searchParams.get('sub'))
          return send(200, { active: false });
        return send(200, {
          active: true,
          userId: s.userId,
          status: s.status,
          roles: s.roles,
          displayName: s.displayName,
        });
      };
      return behaviour.introspectDelayMs > 0
        ? void setTimeout(respond, behaviour.introspectDelayMs)
        : respond();
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const addSession = (over: Partial<FakeSession> = {}) => {
    const session: FakeSession = {
      userId: randomUUID(),
      active: true,
      status: 'ACTIVE',
      roles: ['STUDENT'],
      displayName: 'Alex Tan',
      ...over,
    };
    const sid = randomUUID();
    sessions.set(sid, session);
    return { sid, ...session };
  };

  const mint = async (
    who: { sid: string; userId: string },
    over: {
      expSecondsFromNow?: number;
      issuer?: string;
      privateKey?: CryptoKey;
      kid?: string;
      omitSid?: boolean;
    } = {},
  ) => {
    const jwt = new SignJWT(over.omitSid ? {} : { sid: who.sid })
      .setProtectedHeader({ alg: 'EdDSA', kid: over.kid ?? keys.kid })
      .setIssuer(over.issuer ?? 'foc-user-service')
      .setSubject(who.userId)
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) + (over.expSecondsFromNow ?? 900));
    return jwt.sign(over.privateKey ?? keys.privateKey);
  };

  return {
    url,
    stats,
    behaviour,
    sessions,
    addSession,
    mint,
    /** Convenience: a session plus a token for it. */
    async login(over: Partial<FakeSession> = {}) {
      const s = addSession(over);
      return { ...s, token: await mint(s) };
    },
    rotateKey: async () => void (keys = await newKeys()),
    foreignKey: async () => (await newKeys()).privateKey,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeUserService = Awaited<ReturnType<typeof startFakeUserService>>;
