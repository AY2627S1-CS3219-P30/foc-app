// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
// Scope: Generated the initial implementation for "let the inbox owner reset the password" (#309).
// Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
//   and conflicts with our architecture before committing.

"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";
import { validateEmail } from "@/lib/validation";
import { vars } from "@/styles/tokens";

/**
 * Asks for a password reset link (`POST /auth/password-reset`, #309). The service answers the same
 * whether or not the address has an account, and so does this page. Also the way back for a student
 * whose address someone else registered: the link sets their own password and activates the account.
 */
export default function ForgotPasswordPage() {
  const hydrated = useHydrated();
  const emailParam = useQueryParam("email");
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [alert, setAlert] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // Prefilled from ?email= (sign-up sends it for an address that is taken) until the user edits it.
  const email = typed ?? emailParam ?? "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const found = validateEmail(email);
    setError(found);
    if (found) return;

    setSubmitting(true);
    const value = email.trim();
    try {
      await userApi.requestPasswordReset(value);
      setSent(value);
    } catch (err) {
      if (!(err instanceof ApiError)) setAlert("Something went wrong. Please try again.");
      else if (err.code === "RATE_LIMITED") {
        setAlert("Too many requests for a reset link. Try again later.");
      } else if (err.details.length > 0) {
        setError("Enter a valid email address.");
        setAlert("Check the highlighted field.");
      } else setAlert(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  // One card for both steps, so the success message lands in a live region that was already there.
  return (
    <AuthCard
      title={sent ? "Check your email" : "Reset your password"}
      intro={
        sent ? undefined : "We'll email you a link to choose a new password for your account."
      }
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <FormAlert tone="success">
        {sent && (
          <>
            If <strong>{sent}</strong> has an account, we&apos;ve emailed it a link to reset its
            password. The link expires soon, and only the newest one works.
          </>
        )}
      </FormAlert>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting} hidden={!!sent}>
        <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
          <FormAlert>{alert}</FormAlert>
          <FormField
            label="NUS email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setTyped(e.target.value)}
            error={error}
            required
          />
          <Button type="submit" full disabled={!hydrated || submitting}>
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
