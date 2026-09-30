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

export default function ActivatePage() {
  const hydrated = useHydrated();
  const linkToken = useQueryParam("token");
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const autoSubmitted = useRef(false);

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
        // There is no way to send a fresh link yet, and registering again is refused (the email is
        // taken), so say so plainly. See "Waiting on the User Service" in the web-app README.
        setMessage(
          "This activation link has expired, and the app can't send a new one yet. " +
            "Contact support to activate your account.",
        );
      } else if (err instanceof ApiError && err.code === "ACTIVATION_TOKEN_INVALID") {
        setMessage("This activation link isn't valid. Check you copied all of it.");
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
    </AuthCard>
  );
}
