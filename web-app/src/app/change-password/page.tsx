"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useAuth } from "@/lib/auth";
import { useHydrated } from "@/lib/use-hydrated";
import { useQueryParam } from "@/lib/use-query-param";
import { ApiError, userApi } from "@/lib/user-api";
import { PASSWORD_MIN, validatePasswordChange, type Errors } from "@/lib/validation";
import { vars } from "@/styles/tokens";

/**
 * Changes a password by proving the current one (`POST /auth/password`). Also the first stop for a
 * bootstrap administrator: their configured password cannot start a session, only replace itself.
 * On success every session of the account ends, so we sign in again with the new password. That
 * sign-in is a separate step: if it fails, the password has still changed and we say so.
 */
export default function ChangePasswordPage() {
  const { login } = useAuth();
  const router = useRouter();
  const hydrated = useHydrated();
  const emailParam = useQueryParam("email");
  const required = useQueryParam("required") === "1";
  const [form, setForm] = useState({ email: "", currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  // The password changed but signing in with it did not: the form has done its job.
  const [changed, setChanged] = useState(false);
  // Prefilled from ?email= (the sign-in page sends it) until the user edits the field.
  const email = emailTouched ? form.email : (emailParam ?? "");

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (key === "email") setEmailTouched(true);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const found = validatePasswordChange({ ...form, email });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      await userApi.changePassword({
        email: email.trim(),
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) setAlert("Something went wrong. Please try again.");
      else if (err.code === "INVALID_CREDENTIALS") {
        setErrors({ currentPassword: "That email and current password don't match an account." });
        setAlert("Check the highlighted fields.");
      } else if (err.details.length > 0) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
        setAlert("Check the highlighted fields.");
      } else if (err.code === "RATE_LIMITED") setAlert("Too many attempts. Wait a few minutes.");
      else setAlert(err.message);
      setSubmitting(false);
      return;
    }
    try {
      await login(email.trim(), form.newPassword);
      router.replace("/feed");
    } catch {
      setChanged(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title={required ? "Choose your password" : "Change password"}
      intro={
        required
          ? "This account was set up with a temporary password. Replace it with your own to continue."
          : "You'll be signed out on your other devices."
      }
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <FormAlert tone="success">
        {changed && (
          <>
            Password changed — <Link href="/login">sign in with your new password</Link>.
          </>
        )}
      </FormAlert>
      {/* method="post": if it were ever submitted natively, the passwords must not end up in a URL. */}
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={submitting} hidden={changed}>
        <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
          <FormAlert>{alert}</FormAlert>
          <FormField
            label="NUS email"
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={set("email")}
            error={errors.email}
            required
          />
          <FormField
            label={required ? "Temporary password" : "Current password"}
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={set("currentPassword")}
            error={errors.currentPassword}
            required
          />
          <FormField
            label="New password"
            type="password"
            name="newPassword"
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN} characters.`}
            value={form.newPassword}
            onChange={set("newPassword")}
            error={errors.newPassword}
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
          <Button type="submit" full disabled={!hydrated || submitting}>
            {submitting ? "Saving…" : "Save and sign in"}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
