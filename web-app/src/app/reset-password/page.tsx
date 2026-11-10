// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
// Scope: Generated the initial implementation for "let the inbox owner reset the password" (#309).
// Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
//   and conflicts with our architecture before committing.

"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, buttonClass } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";
import { PASSWORD_MIN, validatePasswordReset, type Errors } from "@/lib/validation";
import { vars } from "@/styles/tokens";

/**
 * Opened from the password reset email (`/reset-password?token=…`, #309). Sets the new password with
 * `POST /auth/password-reset/confirm`, which also activates an account still waiting for activation
 * and ends every session. Like activation it does not sign in: the success state leads to sign-in.
 * Never submits by itself: the student has to choose the password.
 */
export default function ResetPasswordPage() {
  const hydrated = useHydrated();
  const token = useQueryParam("token");
  const [form, setForm] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const found = validatePasswordReset(form);
    setErrors(found);
    if (Object.keys(found).length > 0 || !token) return;

    setSubmitting(true);
    try {
      await userApi.confirmPasswordReset(token, form.password);
      setDone(true);
    } catch (err) {
      setAlert(describe(err));
      if (err instanceof ApiError && err.details.length > 0) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // One card for every step, so each message lands in a live region that was already there.
  return (
    <AuthCard
      title={done ? "Password changed" : "Choose a new password"}
      intro={
        done
          ? undefined
          : "This signs you out everywhere, and activates your account if it was waiting for activation."
      }
      footer={done ? undefined : <Link href="/login">Back to sign in</Link>}
    >
      <FormAlert tone="success">
        {done && "Your new password is set. Sign in with it to continue."}
      </FormAlert>
      {done ? (
        <Link className={buttonClass({ full: true })} href="/login">
          Sign in
        </Link>
      ) : (
        // method="post": if it were ever submitted natively, the passwords must not end up in a URL.
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
            <FormAlert>
              {token === null ? (
                <>
                  Open this page from the link in your password reset email, or{" "}
                  <Link href="/forgot-password">ask for a new link</Link>.
                </>
              ) : (
                alert
              )}
            </FormAlert>
            <FormField
              label="New password"
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
              label="Confirm new password"
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set("confirm")}
              error={errors.confirm}
              required
            />
            <Button type="submit" full disabled={!hydrated || !token || submitting}>
              {submitting ? "Saving…" : "Save new password"}
            </Button>
          </div>
        </form>
      )}
    </AuthCard>
  );
}

/** A form-level message for each way the reset can fail. The typed passwords are never cleared. */
function describe(err: unknown): React.ReactNode {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "PASSWORD_RESET_TOKEN_INVALID":
      // Also what an older link says once a newer one has been sent.
      return (
        <>
          This reset link isn&apos;t valid. It may have been used already, or a newer one sent.{" "}
          <Link href="/forgot-password">Ask for a new link</Link>.
        </>
      );
    case "PASSWORD_RESET_TOKEN_EXPIRED":
      return (
        <>
          This reset link has expired. <Link href="/forgot-password">Ask for a new link</Link>.
        </>
      );
    case "VALIDATION_FAILED":
      return "Check the highlighted fields.";
    default:
      return err.message;
  }
}
