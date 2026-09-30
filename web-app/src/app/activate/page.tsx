"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";

type State = "idle" | "working" | "done" | "error";

export default function ActivatePage() {
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
        setMessage("This activation link has expired. Register again to get a new one.");
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

  if (state === "done") {
    return (
      <AuthCard title="Account activated">
        <FormAlert tone="success">{message}</FormAlert>
        <Link className="btn btn--primary btn--full" href="/login">
          Sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Activate your account"
      intro="Open the link in the email we sent, or paste its code here."
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <form onSubmit={onSubmit} noValidate aria-busy={state === "working"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {state === "working" && <FormAlert tone="info">Activating…</FormAlert>}
          {state === "error" && message && <FormAlert>{message}</FormAlert>}
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
          <Button type="submit" full disabled={state === "working"}>
            Activate
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
