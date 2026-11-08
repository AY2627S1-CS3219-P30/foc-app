// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-05
// Scope: Generated the initial implementation for "account screens on the real User Service"
//   (USR-05, #193, WEB-00); later bug fixes and new features.
// Author review: Anselm Long, Jonus Ho and Patrick Thomas validated correctness and the
//   implementation, and checked for fatal errors and architectural conflicts, before committing.

"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, buttonClass } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { ApiError, userApi } from "@/lib/user-api";
import { validateRegistration, type Errors } from "@/lib/validation";
import { vars } from "@/styles/tokens";

/**
 * Sign-up asks for no password (#309): whoever signs up has not yet proven the inbox, so the password
 * is chosen on the activation page the emailed link opens.
 */
export default function RegisterPage() {
  const hydrated = useHydrated();
  const [form, setForm] = useState({ email: "", displayName: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const found = validateRegistration(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    const email = form.email.trim();
    try {
      await userApi.register({ email, displayName: form.displayName.trim() });
      setRegistered(email);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setAlert("Something went wrong. Please try again.");
      } else if (err.code === "EMAIL_ALREADY_REGISTERED") {
        setErrors({ email: "An account with this email already exists." });
        // Also the way out when someone else registered the student's address (#309): the reset link
        // goes to the inbox, and sets the inbox owner's password whoever created the account.
        setAlert(
          <>
            This email already has an account. If it&apos;s your address,{" "}
            <Link href={`/forgot-password?email=${encodeURIComponent(email)}`}>
              reset the password
            </Link>{" "}
            to get in, even if you didn&apos;t create the account.
          </>,
        );
      } else if (err.details.length > 0) {
        setErrors(
          Object.fromEntries(
            err.details.map((d) => [
              d.field,
              d.code === "EMAIL_DOMAIN_NOT_ALLOWED" ? "Use your NUS email address." : d.message,
            ]),
          ),
        );
        setAlert("Check the highlighted fields.");
      } else if (err.code === "RATE_LIMITED") {
        setAlert("Too many sign-ups from this network. Try again later.");
      } else {
        setAlert(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // One card for both steps, so the success message lands in a live region that was already there.
  return (
    <AuthCard
      title={registered ? "Check your email" : "Create your account"}
      intro={registered ? undefined : "One account for asking for errands and for running them."}
      footer={
        registered ? (
          <Link href="/login">Back to sign in</Link>
        ) : (
          <>
            Already registered? <Link href="/login">Sign in</Link>
          </>
        )
      }
    >
      <FormAlert tone="success">
        {registered && (
          <>
            We sent an activation link to <strong>{registered}</strong>. Open it soon to choose your
            password and activate your account, then sign in.
          </>
        )}
      </FormAlert>
      {registered ? (
        <Link className={buttonClass({ variant: "outline", full: true })} href="/activate">
          I have an activation code
        </Link>
      ) : (
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
            <FormAlert>{alert}</FormAlert>
            <FormField
              label="NUS email"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              hint="Your @u.nus.edu address."
              value={form.email}
              onChange={set("email")}
              error={errors.email}
              required
            />
            <FormField
              label="Display name"
              name="displayName"
              autoComplete="nickname"
              hint="Shown to students you run errands with."
              value={form.displayName}
              onChange={set("displayName")}
              error={errors.displayName}
              maxLength={50}
              required
            />
            <Button type="submit" full disabled={!hydrated || submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </div>
        </form>
      )}
    </AuthCard>
  );
}
