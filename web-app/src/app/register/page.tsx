"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useHydrated } from "@/lib/use-hydrated";
import { ApiError, DEV_MAILBOX_ENABLED, userApi } from "@/lib/user-api";
import { PASSWORD_MIN, validateRegistration, type Errors } from "@/lib/validation";

export default function RegisterPage() {
  const hydrated = useHydrated();
  const [form, setForm] = useState({ email: "", displayName: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);

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
      await userApi.register({ email, password: form.password, displayName: form.displayName.trim() });
      setRegistered(email);
      if (DEV_MAILBOX_ENABLED) {
        const mail = await userApi.devMailbox(email).catch(() => null);
        if (mail && "token" in mail) setDevToken(mail.token);
      }
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setAlert("Something went wrong. Please try again.");
      } else if (err.code === "EMAIL_ALREADY_REGISTERED") {
        setErrors({ email: "An account with this email already exists." });
        setAlert("Check the highlighted fields.");
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
            We sent an activation link to <strong>{registered}</strong>. Open it to activate your
            account, then sign in.
          </>
        )}
      </FormAlert>
      <FormAlert tone="info">
        {devToken && (
          <>
            Development mailbox:{" "}
            <Link href={`/activate?token=${encodeURIComponent(devToken)}`}>
              open the activation link
            </Link>
          </>
        )}
      </FormAlert>
      {registered ? (
        <Link className="btn btn--outline btn--full" href="/activate">
          I have an activation code
        </Link>
      ) : (
        // method="post": if it were ever submitted natively, the password must not end up in a URL.
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </div>
        </form>
      )}
    </AuthCard>
  );
}
