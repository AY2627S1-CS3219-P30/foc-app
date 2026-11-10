// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-05
// Scope: Generated the initial implementation for "account screens on the real User Service"
//   (USR-05, #193, WEB-00); later bug fixes and new features.
// Author review: Anselm Long, Jonus Ho and Patrick Thomas reviewed the implementation for
//   correctness, ran it against the test suite, and checked that it fits our service boundaries
//   without fatal errors before committing.

"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, buttonClass } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";
import { PASSWORD_MIN, validateActivation, type Errors } from "@/lib/validation";
import { vars } from "@/styles/tokens";

type ResendState = "idle" | "sending" | "sent" | "error";

/**
 * Opened from the activation email (`/activate?token=…`), or reached to paste its code. The student
 * chooses their password here (#309): the emailed token proves the inbox, so only its owner's choice
 * becomes the account's. Opening the link activates nothing: only submitting the form does, with
 * `POST /auth/activate`. Like a reset, it does not sign in: the success state leads to sign-in.
 */
export default function ActivatePage() {
  const hydrated = useHydrated();
  const linkToken = useQueryParam("token");
  const [form, setForm] = useState({ token: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | "activated" | "alreadyActive">(null);
  // The link's own token was refused (expired, or replaced by a newer email): from then on the page
  // asks for a code, so the student can paste the newest one without the old link getting in the way.
  const [linkRefused, setLinkRefused] = useState(false);
  const linkInUse = linkToken && !linkRefused ? linkToken : null;
  const resendEmail = useRef<HTMLInputElement>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const token = linkInUse ?? form.token;
    const found = validateActivation({ ...form, token });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const res = await userApi.activate(token.trim(), form.password);
      setDone(res.alreadyActivated ? "alreadyActive" : "activated");
    } catch (err) {
      setAlert(describe(err));
      if (
        linkInUse &&
        err instanceof ApiError &&
        (err.code === "ACTIVATION_TOKEN_EXPIRED" || err.code === "ACTIVATION_TOKEN_INVALID")
      ) {
        setLinkRefused(true);
      }
      if (err instanceof ApiError && err.code === "ACTIVATION_TOKEN_EXPIRED") {
        resendEmail.current?.focus();
      } else if (err instanceof ApiError && err.details.length > 0) {
        setErrors(
          Object.fromEntries(
            err.details.map((d) => [d.field, d.field === "token" ? "Paste the whole code from the email." : d.message]),
          ),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  // One card for every step, so each message lands in a live region that was already there.
  return (
    <AuthCard
      title={done ? "Account activated" : "Activate your account"}
      intro={
        done
          ? undefined
          : linkInUse
            ? "Choose a password to finish activating your account."
            : "Paste the code from the email we sent, and choose a password."
      }
      footer={
        done === "alreadyActive" ? (
          <>
            Forgot your password? <Link href="/forgot-password">Reset it</Link>
          </>
        ) : done ? undefined : (
          <Link href="/login">Back to sign in</Link>
        )
      }
    >
      <FormAlert tone="success">
        {done === "activated" && "Your account is active. Sign in with your new password."}
        {done === "alreadyActive" &&
          "This account is already active, and its password hasn't changed. Sign in with the password you chose."}
      </FormAlert>
      {done ? (
        <Link className={buttonClass({ full: true })} href="/login">
          Sign in
        </Link>
      ) : (
        // method="post": if it were ever submitted natively, the passwords must not end up in a URL.
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
            <FormAlert>{alert}</FormAlert>
            {/* From the link, the token is already in hand: only a pasted code needs a field. */}
            {linkInUse === null && linkToken !== undefined && (
              <FormField
                label="Activation code"
                name="token"
                autoComplete="one-time-code"
                spellCheck={false}
                value={form.token}
                onChange={set("token")}
                error={errors.token}
                required
              />
            )}
            <FormField
              label="Password"
              type="password"
              name="password"
              autoComplete="new-password"
              hint={`At least ${PASSWORD_MIN} characters. A short phrase works well.`}
              value={form.password}
              onChange={set("password")}
              error={errors.password}
              required
            />
            <FormField
              label="Confirm password"
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set("confirm")}
              error={errors.confirm}
              required
            />
            <Button type="submit" full disabled={!hydrated || submitting}>
              {submitting ? "Activating…" : "Activate account"}
            </Button>
          </div>
        </form>
      )}
      {!done && <ResendForm inputRef={resendEmail} />}
    </AuthCard>
  );
}

/** A form-level message for each way activation can fail. The typed passwords are never cleared. */
function describe(err: unknown): React.ReactNode {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "ACTIVATION_TOKEN_EXPIRED":
      return "This activation link has expired. Ask for a new one below, then open it or paste its code here.";
    case "ACTIVATION_TOKEN_INVALID":
      // Also what an older link says once a newer one has been sent.
      return (
        "This activation link isn't valid. Check you copied all of it, " +
        "or use the newest email we sent. You can ask for a new link below."
      );
    case "VALIDATION_FAILED":
      return "Check the highlighted fields.";
    default:
      return err.message;
  }
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
