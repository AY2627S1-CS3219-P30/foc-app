import { ApiError, type UserApi } from "./user-api";

/**
 * Sessions (USR-02's design, decisions.md A3/A5 and W1/W2). Kept free of React so these rules are
 * unit-tested with a fake `fetch`, fake locks and a fake tab channel (test/session.test.ts):
 *
 * - The access token lives in memory only — never localStorage or a cookie — so an XSS bug cannot lift
 *   a long-lived credential. A reload loses it, so every cold load calls `/auth/refresh`, which uses the
 *   HttpOnly `foc_refresh` cookie the page cannot read.
 * - Refresh **rotates** the cookie, and presenting an already-rotated cookie revokes the whole session.
 *   So refresh is single-flight within a tab (one shared promise) and across tabs (a Web Lock), and a
 *   `401` that lands after another call has already refreshed retries with that newer token instead
 *   of rotating again.
 * - Only the service refusing the cookie (401/403) ends the session. Offline, a timeout or a 5xx leave
 *   it alone: a network blip must not sign anyone out.
 * - Signing out has to reach the service, or the cookie stays live for the next person at a shared
 *   computer. Until it has, a non-secret "logout pending" flag is kept (localStorage) and the next load
 *   revokes the cookie instead of refreshing it.
 * - Signing out in one tab signs out the others.
 */

export const REFRESH_LOCK = "foc-auth-refresh";
const LOGOUT_MESSAGE = "logout";

/**
 * `401`s that say nothing about the access token: the action wants the password re-entered, or a
 * re-entered password was wrong (ADR 0008). Refreshing would rotate the cookie for nothing, and
 * replaying a wrong password would spend a second of its limited attempts.
 */
const NOT_ABOUT_THE_TOKEN = new Set(["STEP_UP_REQUIRED", "INVALID_CREDENTIALS"]);

/** What a refresh found: a live session, none (refused, or never there), or no answer at all. */
export type RefreshResult =
  | { kind: "ok"; token: string; userId: string }
  | { kind: "ended" }
  | { kind: "unavailable"; error: ApiError };

/** Signed out on purpose (in this tab or another), or the service had no session for us. */
export type EndReason = "loggedOut" | "noSession";

/** The part of the Web Locks API this needs. */
export type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

/** A boolean that outlives the page. */
export type Flag = { get(): boolean; set(value: boolean): void };

/** A message bus between the app's tabs. */
export type TabChannel = {
  post(message: string): void;
  subscribe(listener: (message: unknown) => void): () => void;
};

export type Session = ReturnType<typeof createSession>;

export function createSession({
  api,
  locks,
  logoutPending = memoryFlag(),
  onEnded,
  onUserChanged,
}: {
  api: Pick<UserApi, "refresh" | "logout">;
  /** Serialises refresh across tabs; without it only this tab is single-flight. */
  locks?: Locks;
  logoutPending?: Flag;
  /** The session is over: drop the signed-in state. */
  onEnded: (reason: EndReason) => void;
  /** A refresh came back for another account (signed in from another tab): reload the user. */
  onUserChanged: (token: string) => void;
}) {
  let current: { token: string; userId: string } | null = null;
  let inflight: Promise<RefreshResult> | null = null;
  let channel: TabChannel | null = null;
  // Bumped on every sign-in and sign-out, so a refresh already in flight cannot undo either.
  let epoch = 0;

  function end(reason: EndReason) {
    current = null;
    epoch++;
    onEnded(reason);
  }

  /** Asks the service to revoke the cookie. True once it has. */
  async function revoke(): Promise<boolean> {
    try {
      await api.logout();
      logoutPending.set(false);
      return true;
    } catch {
      return false;
    }
  }

  async function rotate(correlationId?: string): Promise<RefreshResult> {
    // A sign-out that never reached the service: finish it rather than use the session.
    if (logoutPending.get()) {
      await revoke();
      return { kind: "ended" };
    }
    try {
      const res = await api.refresh(correlationId);
      return { kind: "ok", token: res.accessToken, userId: res.user.id };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        return { kind: "ended" };
      }
      return { kind: "unavailable", error: asApiError(err) };
    }
  }

  /**
   * `correlationId` is the user action the refresh is part of. A refresh already in flight is
   * shared, so it carries the ID of the action that started it.
   */
  function refresh(correlationId?: string): Promise<RefreshResult> {
    if (inflight) return inflight;
    const started = epoch;
    const run = () => rotate(correlationId);
    inflight = (locks ? locks.request(REFRESH_LOCK, run) : run())
      .catch((err): RefreshResult => ({ kind: "unavailable", error: asApiError(err) }))
      .then((result): RefreshResult => {
        // Signed in or out meanwhile: that is the newer truth.
        if (epoch !== started) return current ? { kind: "ok", ...current } : { kind: "ended" };
        if (result.kind === "ok") {
          const previous = current?.userId;
          current = { token: result.token, userId: result.userId };
          if (previous && previous !== result.userId) onUserChanged(result.token);
        } else if (result.kind === "ended") {
          end("noSession");
        }
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** A token from a refresh; throws when there is no session or no answer. */
  async function fresh(correlationId?: string): Promise<string> {
    const result = await refresh(correlationId);
    if (result.kind === "ok") return result.token;
    if (result.kind === "unavailable") throw result.error;
    throw new ApiError(401, "UNAUTHENTICATED", "Your session has ended. Please sign in again.");
  }

  /**
   * Runs a call with the current access token, refreshing once and retrying if it has expired. A
   * refresh it makes belongs to the user action `correlationId` names, like the call itself.
   */
  async function authed<T>(fn: (token: string) => Promise<T>, correlationId?: string): Promise<T> {
    const used = current?.token ?? (await fresh(correlationId));
    const owner = current?.userId;
    try {
      return await fn(used);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401 || NOT_ABOUT_THE_TOKEN.has(err.code)) {
        throw err;
      }
      // Expired (15 min) or revoked. If another call has refreshed since this one started, use its
      // token: refreshing again would rotate the cookie for nothing.
      const latest = current?.token;
      const retry = latest && latest !== used ? latest : await fresh(correlationId);
      // Never replay a call as someone else.
      if (owner && current?.userId !== owner) {
        throw new ApiError(
          409,
          "SESSION_CHANGED",
          "This browser was signed in to a different account in another tab, so nothing was saved.",
        );
      }
      return fn(retry);
    }
  }

  /**
   * Revokes the cookie, then signs out here and in the other tabs. Resolves false if the service could
   * not be reached: the flag stays set and the next load finishes the job.
   */
  async function logout(): Promise<boolean> {
    // Set first, so a tab closed mid-request still leaves the job for the next load.
    logoutPending.set(true);
    const revoked = await revoke();
    end("loggedOut");
    channel?.post(LOGOUT_MESSAGE);
    return revoked;
  }

  /** Signs this tab out when another one signs out. Returns a function that stops listening. */
  function connect(ch: TabChannel): () => void {
    channel = ch;
    const stop = ch.subscribe((message) => {
      if (message === LOGOUT_MESSAGE) end("loggedOut");
    });
    return () => {
      stop();
      if (channel === ch) channel = null;
    };
  }

  return {
    /** The access token in memory, if any. */
    token: () => current?.token ?? null,
    /** After a sign-in. Its cookie replaced any old one, so a pending sign-out has nothing left to do. */
    signedIn(token: string, userId: string) {
      current = { token, userId };
      epoch++;
      logoutPending.set(false);
    },
    refresh,
    authed,
    logout,
    /** Tries a pending sign-out again. True once the service has revoked the cookie. */
    retryLogout: () => (logoutPending.get() ? revoke() : Promise.resolve(true)),
    logoutPending: () => logoutPending.get(),
    connect,
  };
}

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError
    ? err
    : new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
}

export function memoryFlag(initial = false): Flag {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

// ---- Browser adapters -------------------------------------------------------------------------

/** `navigator.locks`, where the browser has it (secure contexts only). */
export function browserLocks(): Locks | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return undefined;
  const locks = navigator.locks;
  // The lock resolves with the callback's result; `.then` flattens lib.dom's nested typing.
  return { request: (name, callback) => locks.request(name, callback).then((result) => result) };
}

/**
 * A flag in localStorage, so every tab and the next visit see it. Where storage is blocked (some
 * private modes) it falls back to this tab's memory, which still covers this tab.
 */
export function storedFlag(key: string): Flag {
  let fallback = false;
  return {
    get() {
      try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : stored === "1";
      } catch {
        return fallback;
      }
    },
    set(value) {
      fallback = value;
      try {
        if (value) localStorage.setItem(key, "1");
        else localStorage.removeItem(key);
      } catch {
        // Blocked: `fallback` still holds it for this tab.
      }
    },
  };
}

/** A BroadcastChannel, where the browser has one. Unsubscribing closes it. */
export function browserChannel(name: string): TabChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const bc = new BroadcastChannel(name);
  return {
    post: (message) => bc.postMessage(message),
    subscribe(listener) {
      const onMessage = (e: MessageEvent) => listener(e.data);
      bc.addEventListener("message", onMessage);
      return () => {
        bc.removeEventListener("message", onMessage);
        bc.close();
      };
    },
  };
}
