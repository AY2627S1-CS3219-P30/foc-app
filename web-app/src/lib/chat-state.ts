import { ApiError } from "./api-client";
import * as api from "./chat-api";
import type { Channel, Message } from "./chat-api";

type Authed = <T>(call: (token: string) => Promise<T>) => Promise<T>;
export type Outgoing = {
  clientId: string;
  body: string;
  sentAt: string;
  state: "pending" | "failed";
  error?: string;
};
export type ChatSnapshot = {
  channel: Channel | null;
  messages: Message[];
  outgoing: Outgoing[];
  loading: boolean;
  olderLoading: boolean;
  hasOlder: boolean;
  absent: boolean;
  error: ApiError | null;
  readError: string | null;
  closed: boolean;
  retryAt: number;
};
export const messageLength = (body: string) => [...body].length;
export const validMessage = (body: string) => body.trim().length > 0 && messageLength(body) <= 280;

/** UUID v4 also on HTTP LAN origins, where randomUUID is unavailable. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const asError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, "NETWORK", "Chat could not connect. Try again.");

/** One private, disposable conversation. Async work can only update its original identity's store. */
export function createChatState(orderId: string, userId: string, authed: Authed, readOnly = false) {
  let state: ChatSnapshot = {
    channel: null,
    messages: [],
    outgoing: [],
    loading: true,
    olderLoading: false,
    hasOlder: false,
    absent: false,
    error: null,
    readError: null,
    closed: false,
    retryAt: 0,
  };
  const listeners = new Set<() => void>();
  let lifetime = new AbortController();
  let cursor: number | null = null;
  let readBusy = false;
  let accessRevision = 0;
  let orderVersion: number | undefined;
  const scope = () => {
    const signal = lifetime.signal;
    const revision = accessRevision;
    return { signal, current: () => !signal.aborted && revision === accessRevision };
  };
  const update = (patch: Partial<ChatSnapshot>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const merge = (items: Message[]) => {
    const bySeq = new Map(state.messages.map((m) => [m.seq, m]));
    items.forEach((m) => bySeq.set(m.seq, m));
    const messages = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    update({
      messages,
      outgoing: state.outgoing.filter(
        (p) => !messages.some((m) => m.senderId === userId && m.clientId === p.clientId),
      ),
    });
  };
  const failed = (err: unknown) => {
    const error = asError(err);
    if ([401, 403, 404].includes(error.status)) {
      // Revoked access must remove cached text and names, including failed drafts.
      cursor = null;
      accessRevision++;
      update({
        channel: null,
        messages: [],
        outgoing: [],
        hasOlder: false,
        olderLoading: false,
        absent: error.status === 404,
        error: error.status === 404 ? null : error,
        loading: false,
      });
    } else update({ error, loading: false });
  };
  async function refresh(
    signal: AbortSignal,
    final: boolean,
    version?: number,
  ): Promise<number | null> {
    const { current } = scope();
    const valid = () => !signal.aborted && current();
    try {
      const channel = await authed((t) => api.getChannel(t, orderId, signal));
      if (!valid()) return null;
      if (version !== orderVersion && channel.open) update({ closed: false });
      orderVersion = version;
      update({
        channel: {
          ...channel,
          lastReadSeq: Math.max(channel.lastReadSeq, state.channel?.lastReadSeq ?? 0),
        },
        absent: false,
        error: null,
      });
      if (cursor === null) {
        const page = await authed((t) => api.listMessages(t, orderId, { limit: 100 }, signal));
        if (!valid()) return null;
        merge(page.items);
        update({ hasOlder: page.hasMore });
        // Also fetch unread messages preceding the latest history page, so unread is exact.
        cursor = Math.min(channel.lastReadSeq, page.items[0]?.seq ? page.items[0].seq - 1 : 0);
      }
      let more = true;
      while (more) {
        const after: number = cursor;
        const page = await authed((t) =>
          api.listMessages(t, orderId, { after, limit: 100 }, signal),
        );
        if (!valid()) return null;
        merge(page.items);
        const next = page.items.at(-1)?.seq ?? after;
        if (page.hasMore && next <= after)
          throw new ApiError(0, "NETWORK", "Chat history could not advance. Try again.");
        cursor = next;
        more = page.hasMore;
      }
      update({ loading: false, error: null, hasOlder: (state.messages[0]?.seq ?? 1) > 1 });
      // Polling for now. A notify-only WebSocket replaces this timer later (ADR 0012); reads stay on GET /messages.
      return channel.open && !state.closed && !final ? 2_000 : null;
    } catch (err) {
      if (!valid()) return null;
      failed(err);
      return [401, 403, 404].includes(asError(err).status) ||
        final ||
        state.closed ||
        state.channel?.open === false
        ? null
        : 2_000;
    }
  }
  async function older() {
    if (state.olderLoading || !state.hasOlder || !state.channel) return;
    const { signal, current } = scope();
    update({ olderLoading: true });
    try {
      const page = await authed((t) =>
        api.listMessages(t, orderId, { before: state.messages[0]?.seq, limit: 100 }, signal),
      );
      if (!current()) return;
      merge(page.items);
      update({ hasOlder: page.hasMore, error: null });
    } catch (err) {
      if (current()) failed(err);
    } finally {
      if (current()) update({ olderLoading: false });
    }
  }
  async function transmit(outgoing: Outgoing, final: boolean) {
    if (
      final ||
      readOnly ||
      !state.channel?.open ||
      state.channel.myRole === "ADMIN" ||
      state.closed ||
      Date.now() < state.retryAt
    )
      return;
    const { signal, current } = scope();
    update({
      outgoing: state.outgoing.some((p) => p.clientId === outgoing.clientId)
        ? state.outgoing.map((p) =>
            p.clientId === outgoing.clientId ? { ...p, state: "pending", error: undefined } : p,
          )
        : [...state.outgoing, { ...outgoing, state: "pending", error: undefined }],
    });
    try {
      const message = await authed((t) =>
        api.sendMessage(t, orderId, { clientId: outgoing.clientId, body: outgoing.body }, signal),
      );
      if (current()) merge([message]);
    } catch (err) {
      if (!current()) return;
      const error = asError(err);
      if ([401, 403, 404].includes(error.status)) {
        failed(error);
        return;
      }
      const retry = Number(error.headers.get("Retry-After"));
      const retryAt =
        error.status === 429
          ? Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1_000
          : state.retryAt;
      update({
        closed: state.closed || (error.status === 409 && error.code === "CHANNEL_CLOSED"),
        retryAt,
        // A concurrent GET may already have confirmed this clientId. Never resurrect it as failed.
        outgoing: state.outgoing.map((p) =>
          p.clientId === outgoing.clientId ? { ...p, state: "failed", error: error.message } : p,
        ),
      });
    }
  }
  async function markVisibleRead(visible: boolean, bottom: boolean) {
    const channel = state.channel;
    // Only fetched, contiguous messages count; a send response can be ahead of our GET cursor.
    const seq = cursor ?? 0;
    if (
      !visible ||
      !bottom ||
      readOnly ||
      !channel ||
      channel.myRole === "ADMIN" ||
      readBusy ||
      seq <= channel.lastReadSeq
    )
      return;
    readBusy = true;
    const { signal, current } = scope();
    try {
      const read = await authed((t) => api.markRead(t, orderId, seq, signal));
      if (current() && state.channel)
        update({
          channel: {
            ...state.channel,
            lastReadSeq: Math.max(state.channel.lastReadSeq, read.lastReadSeq),
          },
          readError: null,
        });
    } catch (err) {
      if (current()) {
        if ([401, 403, 404].includes(asError(err).status)) failed(err);
        else
          update({
            readError: "Could not save your read position. It will retry when chat refreshes.",
          });
      }
    } finally {
      readBusy = false;
    }
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => {
      if (lifetime.signal.aborted) lifetime = new AbortController();
      return () => lifetime.abort();
    },
    refresh,
    older,
    markVisibleRead,
    send: (body: string, final: boolean) =>
      validMessage(body)
        ? transmit(
            { clientId: newClientId(), body, sentAt: new Date().toISOString(), state: "pending" },
            final,
          )
        : Promise.resolve(),
    retry: (clientId: string, final: boolean) => {
      const outgoing = state.outgoing.find((p) => p.clientId === clientId && p.state === "failed");
      return outgoing ? transmit(outgoing, final) : Promise.resolve();
    },
    unread: () =>
      readOnly || state.channel?.myRole === "ADMIN"
        ? 0
        : state.messages.filter(
            (m) => m.senderId !== userId && m.seq > (state.channel?.lastReadSeq ?? 0),
          ).length,
  };
}
