"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, userApi, type Me, type PreferredMode, type Profile } from "./user-api";

type Status = "loading" | "signedIn" | "signedOut";

type Auth = {
  status: Status;
  user: Me | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Runs a call with the current access token, refreshing once and retrying if it has expired. */
  authed: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  updateProfile: (changes: Partial<Profile>) => Promise<Me>;
  setMode: (mode: PreferredMode) => Promise<void>;
};

const AuthContext = createContext<Auth | null>(null);
const CHANNEL = "foc-auth";
const REFRESH_LOCK = "foc-auth-refresh";

/**
 * Sessions (USR-02's design, decisions.md A3/A5):
 *
 * - The access token lives in this component's memory only — never localStorage or a cookie — so an
 *   XSS bug cannot lift a long-lived credential. A reload loses it, so every cold load calls
 *   `/auth/refresh`, which uses the HttpOnly `foc_refresh` cookie the page cannot read.
 * - Refresh **rotates** the cookie, and presenting an already-rotated cookie revokes the whole session.
 *   Two tabs restored together would both present the same cookie and sign each other out. So refresh
 *   is single-flight within a tab (one shared promise) and across tabs (a Web Lock): the second tab
 *   waits, then presents the cookie the first one just received.
 * - Signing out in one tab signs out the others (BroadcastChannel).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const token = useRef<string | null>(null);
  const inflight = useRef<Promise<string | null> | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const signedOut = useCallback(() => {
    token.current = null;
    setUser(null);
    setStatus("signedOut");
  }, []);

  /** Returns a fresh access token, or null when there is no live session. */
  const refresh = useCallback((): Promise<string | null> => {
    if (inflight.current) return inflight.current;
    const run = async () => {
      try {
        const res = await userApi.refresh();
        token.current = res.accessToken;
        return res.accessToken;
      } catch (err) {
        // 401/403: the session is over. Anything else (offline, 5xx) also leaves us without a token.
        if (err instanceof ApiError && err.status !== 0 && err.status < 500) token.current = null;
        return null;
      }
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    // The Web Lock resolves with the callback's result; `.then` flattens lib.dom's nested typing.
    const locked = locks ? locks.request(REFRESH_LOCK, run).then((token) => token) : run();
    const p = locked.finally(() => {
      inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, []);

  const loadMe = useCallback(
    async (accessToken: string) => {
      const me = await userApi.me(accessToken);
      setUser(me);
      setStatus("signedIn");
      return me;
    },
    [],
  );

  // Cold load: is there a session behind the cookie?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await refresh();
      if (cancelled) return;
      if (!t) return signedOut();
      try {
        await loadMe(t);
      } catch {
        if (!cancelled) signedOut();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, loadMe, signedOut]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e: MessageEvent) => {
      if (e.data === "logout") signedOut();
    };
    channel.current = bc;
    return () => bc.close();
  }, [signedOut]);

  const authed = useCallback(
    async <T,>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
      const current = token.current ?? (await refresh());
      if (!current) {
        signedOut();
        throw new ApiError(401, "UNAUTHENTICATED", "Your session has ended. Please sign in again.");
      }
      try {
        return await fn(current);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        // The access token expired (15 min) or the session was revoked: try one refresh.
        const next = await refresh();
        if (!next) {
          signedOut();
          throw err;
        }
        return fn(next);
      }
    },
    [refresh, signedOut],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await userApi.login(email, password);
      token.current = res.accessToken;
      await loadMe(res.accessToken);
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await userApi.logout();
    } catch {
      // Sign out locally regardless: the in-memory token goes, and the cookie dies at its expiry.
    }
    signedOut();
    channel.current?.postMessage("logout");
  }, [signedOut]);

  const updateProfile = useCallback(
    async (changes: Partial<Profile>) => {
      const me = await authed((t) => userApi.updateMe(t, changes));
      setUser(me);
      return me;
    },
    [authed],
  );

  const setMode = useCallback(
    async (mode: PreferredMode) => {
      const previous = user;
      // Optimistic: the switch responds at once, and reverts if the server refuses.
      if (previous) setUser({ ...previous, profile: { ...previous.profile, preferredMode: mode } });
      try {
        await updateProfile({ preferredMode: mode });
      } catch (err) {
        setUser(previous);
        throw err;
      }
    },
    [user, updateProfile],
  );

  const value = useMemo(
    () => ({ status, user, login, logout, authed, updateProfile, setMode }),
    [status, user, login, logout, authed, updateProfile, setMode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
