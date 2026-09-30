"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useAuth } from "@/lib/auth";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError } from "@/lib/user-api";
import { safeNext, validateLogin, type Errors } from "@/lib/validation";

export default function LoginPage() {
  const { login, status, logoutPending, retryLogout } = useAuth();
  const router = useRouter();
  const hydrated = useHydrated();
  const next = useQueryParam("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [logoutConfirmed, setLogoutConfirmed] = useState(false);

  // Signed in — restored on load, or just now by the form: go on, in one navigation.
  useEffect(() => {
    if (status === "signedIn") router.replace(safeNext(next));
  }, [status, next, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const found = validateLogin({ email, password });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setAlert(describe(err));
      if (err instanceof ApiError && err.details.length > 0) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      }
      if (err instanceof ApiError && err.code === "PASSWORD_CHANGE_REQUIRED") {
        router.push(`/change-password?email=${encodeURIComponent(email.trim())}&required=1`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onRetryLogout() {
    setRetrying(true);
    setLogoutConfirmed(await retryLogout());
    setRetrying(false);
  }

  return (
    <AuthCard
      title="Sign in"
      intro="Campus errands, run by students."
      footer={
        <>
          New here? <Link href="/register">Create an account</Link>
        </>
      }
    >
      <FormAlert tone="info">
        {logoutPending ? (
          <>
            You&apos;re signed out here, but the server didn&apos;t confirm it, so we&apos;ll finish
            the next time this app opens.{" "}
            <button type="button" onClick={() => void onRetryLogout()} disabled={retrying}>
              {retrying ? "Trying…" : "Try again now"}
            </button>
          </>
        ) : (
          logoutConfirmed && "You're signed out."
        )}
      </FormAlert>
      {/* method="post": if it were ever submitted natively, the password must not end up in a URL. */}
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <FormAlert>{alert}</FormAlert>
          <FormField
            label="NUS email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            required
          />
          <FormField
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
            required
          />
          <Button type="submit" full disabled={!hydrated || submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
          <p style={{ fontSize: 13, textAlign: "center" }}>
            <Link href="/change-password" style={{ color: "var(--color-primary)" }}>
              Change your password
            </Link>
          </p>
        </div>
      </form>
    </AuthCard>
  );
}

/** A form-level message for each way sign-in can fail. The typed password is never cleared. */
function describe(err: unknown): React.ReactNode {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "INVALID_CREDENTIALS":
      return "That email and password don't match an account.";
    case "ACCOUNT_NOT_ACTIVATED":
      return (
        <>
          Activate your account first — use the link we emailed you, or{" "}
          <Link href="/activate">enter your activation code</Link>.
        </>
      );
    case "ACCOUNT_SUSPENDED":
      return "This account is suspended. Contact an administrator if you think this is a mistake.";
    case "PASSWORD_CHANGE_REQUIRED":
      return "Choose a new password to finish setting up this account.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a few minutes and try again.";
    case "VALIDATION_FAILED":
      return "Check the highlighted fields.";
    default:
      return err.message;
  }
}
