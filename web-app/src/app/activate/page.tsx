"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, buttonClass } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";
import { vars } from "@/styles/tokens";

type State = "idle" | "working" | "done" | "error";
type ResendState = "idle" | "sending" | "sent" | "error";

export default function ActivatePage() {
  const hydrated = useHydrated();
  const linkToken = useQueryParam("token");
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const autoSubmitted = useRef(false);
  const resendEmail = useRef<HTMLInputElement>(null);

  async function activate(value: string) {
    setState("working");
    setMessage(null);
    try {
      const res = await userApi.activate(value);
      setState("done");
      setMessage(
        res.alreadyActivated ? "This account is already active." : "Your account is active.",
      );
    } catch (err) {
      setState("error");
      if (err instanceof ApiError && err.code === "ACTIVATION_TOKEN_EXPIRED") {
        setMessage("This activation link has expired. Ask for a new one below.");
        resendEmail.current?.focus();
      } else if (err instanceof ApiError && err.code === "ACTIVATION_TOKEN_INVALID") {
        // Also what an older link says once a newer one has been sent.
        setMessage(
          "This activation link isn't valid. Check you copied all of it, " +
            "or use the newest email we sent. You can ask for a new link below.",
        );
      } else if (err instanceof ApiError && err.details.length > 0) {
        setFieldError("Paste the whole code from the email.");
        setMessage("Check the highlighted field.");
      } else {
        setMessage(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    }
  }

  // Opened from the email link: activate straight away, once (a replay is harmless but noisy).
  useEffect(() => {
    if (!linkToken || autoSubmitted.current) return;
    autoSubmitted.current = true;
    setToken(linkToken);
    void activate(linkToken);
  }, [linkToken]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!value) {
      setFieldError("Paste the activation code from the email.");
      return;
    }
    setFieldError(undefined);
    void activate(value);
  }

  const done = state === "done";

  // One card for every step, so each message lands in a live region that was already there.
  return (
    <AuthCard
      title={done ? "Account activated" : "Activate your account"}
      intro={done ? undefined : "Open the link in the email we sent, or paste its code here."}
      footer={done ? undefined : <Link href="/login">Back to sign in</Link>}
    >
      <FormAlert tone="success">{done && message}</FormAlert>
      {done ? (
        <Link className={buttonClass({ full: true })} href="/login">
          Sign in
        </Link>
      ) : (
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={state === "working"}>
          <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
            <FormAlert tone="info">{state === "working" && "Activating…"}</FormAlert>
            <FormAlert>{state === "error" && message}</FormAlert>
            <FormField
              label="Activation code"
              name="token"
              autoComplete="one-time-code"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              error={fieldError}
              required
            />
            <Button type="submit" full disabled={!hydrated || state === "working"}>
              Activate
            </Button>
          </div>
        </form>
      )}
      {!done && <ResendForm inputRef={resendEmail} />}
    </AuthCard>
  );
}

/** "Send a new link": the service answers the same whether or not the address has an account. */
function ResendForm({ inputRef }: { inputRef: React.Ref<HTMLInputElement> }) {
  const hydrated = useHydrated();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<ResendState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) {
      setFieldError("Enter the email you signed up with.");
      return;
    }
    setFieldError(undefined);
    setState("sending");
    setMessage(null);
    try {
      await userApi.resendActivation(value);
      setState("sent");
      setMessage(
        `If ${value} has an account waiting for activation, a new link is on its way. ` +
          "Earlier links no longer work.",
      );
    } catch (err) {
      setState("error");
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        setMessage("Too many requests for a new link. Try again later.");
      } else if (err instanceof ApiError && err.details.length > 0) {
        setFieldError("Enter a valid email address.");
        setMessage("Check the highlighted field.");
      } else {
        setMessage(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    }
  }

  return (
    <form
      method="post"
      onSubmit={onSubmit}
      noValidate
      aria-busy={state === "sending"}
      aria-labelledby="resend-heading"
      style={{ marginTop: vars.space[6] }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
        <h2 id="resend-heading" style={{ fontSize: vars.text.md, margin: 0 }}>
          Didn&apos;t get the email, or the link expired?
        </h2>
        <FormAlert tone="success">{state === "sent" && message}</FormAlert>
        <FormAlert>{state === "error" && message}</FormAlert>
        <FormField
          ref={inputRef}
          label="NUS email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError}
          required
        />
        <Button
          type="submit"
          variant="outline"
          full
          disabled={!hydrated || state === "sending"}
        >
          {state === "sending" ? "Sending…" : "Send a new link"}
        </Button>
      </div>
    </form>
  );
}
