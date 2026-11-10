// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-04
// Scope: Bug fixes, including "address chat review findings".
// Author review: Patrick Thomas reviewed the implementation for correctness, ran it against the
//   test suite, and checked that it fits our service boundaries without fatal errors before
//   committing.

"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { messageLength, validMessage } from "@/lib/chat-state";
import { useChat } from "@/lib/use-chat";
import { useNowAfter } from "@/lib/use-now";
import { Button } from "./Button";
import { Field } from "./Field";
import { FormAlert } from "./FormField";
import { ErrorState, LoadingState } from "./States";
import { Textarea } from "./Textarea";
import styles from "./ChatPanel.module.css";

const subscribeWidth = (fn: () => void) => {
  const query = window.matchMedia("(min-width: 768px)");
  query.addEventListener("change", fn);
  return () => query.removeEventListener("change", fn);
};
const wideSnapshot = () => window.matchMedia("(min-width: 768px)").matches;
const serverWidth = () => false;

/** Key the entire private view, including its draft and scroll state, by account and order. */
export function ChatPanel(props: {
  orderId: string;
  version?: number;
  final?: boolean;
  readOnly?: boolean;
}) {
  const { user } = useAuth();
  return user ? (
    <Conversation key={`${user.id}:${props.orderId}:${!!props.readOnly}`} {...props} />
  ) : null;
}

function Conversation({
  orderId,
  version,
  final = false,
  readOnly = false,
}: {
  orderId: string;
  version?: number;
  final?: boolean;
  readOnly?: boolean;
}) {
  const { user } = useAuth();
  const chat = useChat(orderId, version, final, readOnly);
  const { markRead } = chat;
  const hasChannel = !!chat.channel;
  const wide = useSyncExternalStore(subscribeWidth, wideSnapshot, serverWidth);
  const [mobileOpen, setMobileOpen] = useState(false);
  const expanded = wide || mobileOpen;
  const [draft, setDraft] = useState("");
  const [bottom, setBottom] = useState(true);
  const [visible, setVisible] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const now = useNowAfter(() => chat.retryAt || null);
  const rateLimited = now < chat.retryAt;
  const reason =
    readOnly || chat.channel?.myRole === "ADMIN"
      ? "Administrator view: read only."
      : final
        ? "This errand has ended. You can still read its conversation."
        : chat.closed || chat.channel?.open === false
          ? "This channel is closed. You can still read its conversation."
          : rateLimited
            ? `Too many messages. Try again after ${new Date(chat.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}.`
            : chat.error
              ? "Chat is unavailable. Refresh before sending."
              : null;
  const disabled = !!reason || !chat.channel;
  const length = messageLength(draft);
  const latest = chat.messages.at(-1)?.seq ?? 0;
  const first = chat.messages[0]?.seq ?? 0;
  const scrollToBottom = () => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    atBottom.current = true;
    setBottom(true);
    log.current?.focus({ preventScroll: true });
  };

  // The anchor lives exactly as long as one older-history load, however that load ends.
  useLayoutEffect(() => {
    const el = log.current;
    if (chat.olderLoading) {
      if (el && !prepend.current) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      return;
    }
    const anchor = prepend.current;
    prepend.current = null;
    if (!expanded || !el) return;
    if (anchor) el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [first, latest, chat.outgoing, expanded, chat.loading, chat.olderLoading]);

  useEffect(() => {
    const el = end.current;
    if (!expanded || !el) return;
    let intersects = false;
    const update = () =>
      setVisible(
        intersects && document.visibilityState === "visible" && el.getClientRects().length > 0,
      );
    const observer = new IntersectionObserver((entries) => {
      intersects = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      // Re-opening must wait for the observer to see the bottom again before anything counts as read.
      setVisible(false);
    };
  }, [expanded, chat.loading, hasChannel]);

  useEffect(() => {
    void markRead(expanded && visible && !chat.error, bottom);
  }, [markRead, expanded, visible, bottom, latest, chat.channel, chat.error]);

  if (chat.absent) return null;
  const sender = (id: string) =>
    id === chat.channel?.requester.userId
      ? chat.channel.requester.displayName
      : id === chat.channel?.courier?.userId
        ? chat.channel.courier.displayName
        : "Former courier";

  return (
    <section className={styles.panel} aria-label="Participant chat">
      <div className={styles.header}>
        <h2>Participant chat</h2>
        <span className={styles.unread} role="status">
          {chat.unread} unread
        </span>
        {readOnly && chat.channel && (
          <Button type="button" variant="outline" onClick={chat.refresh}>
            Refresh conversation
          </Button>
        )}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={`chat-${orderId}`}
          onClick={() => setMobileOpen((value) => !value)}
        >
          {expanded ? "Collapse chat" : "Open chat"}
        </button>
      </div>
      <div id={`chat-${orderId}`} hidden={!expanded}>
        {chat.channel && (
          <p className={styles.people}>
            <strong>{chat.channel.requester.displayName}</strong> (requester)
            <br />
            <strong>{chat.channel.courier?.displayName ?? "No assigned courier"}</strong> (courier)
          </p>
        )}
        {chat.loading && <LoadingState label="Loading conversation…" rows={2} />}
        {chat.error && (
          <ErrorState
            title={
              chat.error.status === 403
                ? "You can't access this conversation"
                : "Could not refresh chat"
            }
            onRetry={chat.refresh}
          >
            {chat.error.message}
          </ErrorState>
        )}
        {chat.channel && (
          <>
            <div
              ref={log}
              className={styles.log}
              role="region"
              aria-label="Conversation messages"
              tabIndex={0}
              onScroll={() => {
                const el = log.current!;
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
                setBottom(atBottom.current);
              }}
            >
              {chat.hasOlder && (
                <Button
                  variant="outline"
                  disabled={chat.olderLoading}
                  onClick={() => void chat.loadOlder()}
                >
                  {chat.olderLoading ? "Loading older messages…" : "Load older messages"}
                </Button>
              )}
              {!chat.loading && chat.messages.length === 0 && (
                <p className={styles.empty}>No messages yet. Coordinate your handoff here.</p>
              )}
              <ol className={styles.messages}>
                {chat.messages.map((message) => (
                  <li
                    key={message.seq}
                    className={message.senderId === user?.id ? styles.own : styles.message}
                  >
                    <div className={styles.meta}>
                      <strong>{sender(message.senderId)}</strong>
                      <time dateTime={message.sentAt}>
                        {new Date(message.sentAt).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p>{message.body}</p>
                    {message.senderId === user?.id && <span className={styles.delivery}>Sent</span>}
                  </li>
                ))}
                {chat.outgoing.map((message) => (
                  <li key={message.clientId} className={styles.own}>
                    <div className={styles.meta}>
                      <strong>You</strong>
                      <time dateTime={message.sentAt}>
                        {new Date(message.sentAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p>{message.body}</p>
                    <span className={styles.delivery}>
                      {message.state === "pending" ? "Sending…" : "Failed to send"}
                    </span>
                    {message.state === "failed" && (
                      <>
                        <p className={styles.failure}>{message.error}</p>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() => void chat.retry(message.clientId)}
                        >
                          Retry message
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
              <div ref={end} className={styles.end} aria-hidden="true" />
            </div>
            {!bottom && latest > 0 && (
              <Button variant="outline" onClick={scrollToBottom}>
                New messages
              </Button>
            )}
            <p className={styles.announcement} role="status">
              {chat.outgoing.some((message) => message.state === "pending") && "Sending message…"}
            </p>
            <FormAlert tone="info">{reason}</FormAlert>
            <FormAlert tone="info">{chat.readError}</FormAlert>
            {!readOnly && chat.channel.myRole !== "ADMIN" && (
              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (disabled || !validMessage(draft)) return;
                  void chat.send(draft);
                  setDraft("");
                }}
              >
                <Field
                  label="Message"
                  hint={`${length} / 280 characters`}
                  error={
                    length > 280
                      ? "Use at most 280 characters."
                      : draft.length > 0 && !draft.trim()
                        ? "Enter a message that isn't only whitespace."
                        : draft.includes("\0")
                          ? "Remove the NUL character from your message."
                          : undefined
                  }
                >
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={3}
                    disabled={disabled}
                  />
                </Field>
                <Button type="submit" disabled={disabled || !validMessage(draft)}>
                  Send
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
