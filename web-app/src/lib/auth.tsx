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
import {
  browserChannel,
  browserLocks,
  createSession,
  storedFlag,
  type EndReason,
  type RefreshResult,
} from "./session";
import { newCorrelationId } from "./api-client";
import { ApiError, userApi, type Me, type PreferredMode, type Profile } from "./user-api";

/** `unavailable`: the service could not be asked whether there is a session (offline, down, misconfigured). */
type Status = "loading" | "signedIn" | "signedOut" | "unavailable";

type Auth = {
  status: Status;
  user: Me | null;
  /** Why the last session ended. A deliberate sign-out does not send the user back where they were. */
  endedBy: EndReason | null;
  /** When `unavailable`, what went wrong. */
  problem: string | null;
  /** A sign-out the service has not confirmed yet; the next load finishes it. */
  logoutPending: boolean;
  /** True while the mode switch is saving; further switches wait for it. */
  modeSaving: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Tries a pending sign-out again; true once the service has confirmed it. */
  retryLogout: () => Promise<boolean>;
  /** Asks the service about the session again, after `unavailable`. */
  retry: () => Promise<void>;
  /**
   * Runs a call with the current access token, refreshing once and retrying if it has expired.
   * `correlationId` names the user action the call belongs to, for any refresh it needs (PLT-04).
   */
  authed: <T>(fn: (token: string) => Promise<T>, correlationId?: string) => Promise<T>;
  updateProfile: (changes: Partial<Profile>) => Promise<Me>;
  setMode: (mode: PreferredMode) => Promise<void>;
};

const AuthContext = createContext<Auth | null>(null);
const CHANNEL = "foc-auth";
const LOGOUT_PENDING_KEY = "foc-logout-pending";

const withMode = (user: Me, preferredMode: PreferredMode): Me => ({
  ...user,
  profile: { ...user.profile, preferredMode },
});

/** React state around the session rules in session.ts, which is where the reasoning lives. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const [endedBy, setEndedBy] = useState<EndReason | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const modeBusy = useRef(false);

  const [session] = useState(() => {
    const pending = storedFlag(LOGOUT_PENDING_KEY);
    return createSession({
      api: userApi,
      locks: browserLocks(),
      logoutPending: pending,
      onEnded: (reason) => {
        setUser(null);
        setStatus("signedOut");
        setEndedBy(reason);
        setLogoutPending(pending.get());
      },
      onUserChanged: (token) => {
        // Another tab signed in as someone else: never show one account's data under another's token.
        setUser(null);
        setStatus("loading");
        userApi.me(token).then(
          (me) => {
            setUser(me);
            setStatus("signedIn");
          },
          (err: unknown) => {
            setProblem(messageOf(err));
            setStatus("unavailable");
          },
        );
      },
    });
  });

  /**
   * Takes a cold-load refresh to a signed-in user, or to why there is none. Loading the session is
   * one user action: the refresh and the account read share its correlation ID.
   */
  const settle = useCallback(
    async (result: RefreshResult, action: string) => {
      if (result.kind === "ended") return; // onEnded has signed out
      if (result.kind === "unavailable") {
        setProblem(result.error.message);
        setStatus("unavailable");
        return;
      }
      try {
        const me = await session.authed((t) => userApi.me(t, action), action);
        setUser(me);
        setStatus("signedIn");
      } catch (err) {
        if (session.token() === null) return; // the session ended on the way
        setProblem(messageOf(err));
        setStatus("unavailable");
      }
    },
    [session],
  );

  // Cold load: is there a session behind the cookie?
  useEffect(() => {
    const action = newCorrelationId();
    void (async () => settle(await session.refresh(action), action))();
  }, [session, settle]);

  useEffect(() => {
    const channel = browserChannel(CHANNEL);
    return channel ? session.connect(channel) : undefined;
  }, [session]);

  const retry = useCallback(async () => {
    setProblem(null);
    setStatus("loading");
    const action = newCorrelationId();
    await settle(await session.refresh(action), action);
  }, [session, settle]);

  const authed = useCallback(
    <T,>(fn: (accessToken: string) => Promise<T>, correlationId?: string): Promise<T> =>
      session.authed(fn, correlationId),
    [session],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const action = newCorrelationId(); // signing in and reading the account are one action
      const res = await userApi.login(email, password, action);
      session.signedIn(res.accessToken, res.user.id);
      setLogoutPending(false);
      setEndedBy(null);
      const me = await session.authed((t) => userApi.me(t, action), action);
      setUser(me);
      setProblem(null);
      setStatus("signedIn");
    },
    [session],
  );

  // No navigation here: the (app) layout sends a signed-out visitor to sign in, exactly once.
  const logout = useCallback(async () => {
    await session.logout();
  }, [session]);

  const retryLogout = useCallback(async () => {
    const done = await session.retryLogout();
    setLogoutPending(session.logoutPending());
    return done;
  }, [session]);

  const updateProfile = useCallback(
    async (changes: Partial<Profile>) => {
      const action = newCorrelationId();
      const me = await authed((t) => userApi.updateMe(t, changes, action), action);
      setUser(me);
      return me;
    },
    [authed],
  );

  const setMode = useCallback(
    async (mode: PreferredMode) => {
      const previous = user?.profile.preferredMode;
      // One save at a time, so an older response can never land after a newer choice.
      if (!previous || previous === mode || modeBusy.current) return;
      modeBusy.current = true;
      setModeSaving(true);
      // Optimistic: the switch responds at once. Only preferredMode is touched, here and on revert,
      // so a profile edit saved meanwhile is never overwritten with a stale copy of the user.
      setUser((u) => (u ? withMode(u, mode) : u));
      try {
        const action = newCorrelationId();
        await authed((t) => userApi.updateMe(t, { preferredMode: mode }, action), action);
      } catch (err) {
        setUser((u) => (u && u.profile.preferredMode === mode ? withMode(u, previous) : u));
        throw err;
      } finally {
        modeBusy.current = false;
        setModeSaving(false);
      }
    },
    [user, authed],
  );

  const value = useMemo(
    () => ({
      status,
      user,
      endedBy,
      problem,
      logoutPending,
      modeSaving,
      login,
      logout,
      retryLogout,
      retry,
      authed,
      updateProfile,
      setMode,
    }),
    [
      status,
      user,
      endedBy,
      problem,
      logoutPending,
      modeSaving,
      login,
      logout,
      retryLogout,
      retry,
      authed,
      updateProfile,
      setMode,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}
