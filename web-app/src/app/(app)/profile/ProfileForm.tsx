"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { FormAlert, FormField } from "@/components/FormField";
import { useAuth } from "@/lib/auth";
import { ApiError, type ContactPreference, type Me } from "@/lib/user-api";
import { validateDisplayName, type Errors } from "@/lib/validation";
import { vars } from "@/styles/tokens";

/**
 * Edits the fields a student owns (US-FR3.1.1). Email, roles and status are shown but not editable:
 * the service refuses them anyway (`FIELD_NOT_EDITABLE`). Only changed fields are sent.
 */
export function ProfileForm({ user }: { user: Me }) {
  const { updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user.profile.displayName);
  const [faculty, setFaculty] = useState(user.profile.faculty ?? "");
  const [contact, setContact] = useState<ContactPreference>(user.profile.contactPreference);
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    const nameError = validateDisplayName(displayName);
    setErrors(nameError ? { displayName: nameError } : {});
    if (nameError) return;

    const changes: Parameters<typeof updateProfile>[0] = {};
    if (displayName.trim() !== user.profile.displayName) changes.displayName = displayName.trim();
    const nextFaculty = faculty.trim() || null;
    if (nextFaculty !== user.profile.faculty) changes.faculty = nextFaculty;
    if (contact !== user.profile.contactPreference) changes.contactPreference = contact;
    if (Object.keys(changes).length === 0) {
      setAlert({ tone: "success", text: "Nothing to save." });
      return;
    }

    setSaving(true);
    try {
      await updateProfile(changes);
      setAlert({ tone: "success", text: "Profile saved." });
    } catch (err) {
      if (err instanceof ApiError && err.details.length > 0) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
        setAlert({ tone: "error", text: "Check the highlighted fields." });
      } else {
        setAlert({
          tone: "error",
          text: err instanceof ApiError ? err.message : "Couldn't save. Try again.",
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={saving} className="card">
      <div style={{ display: "flex", flexDirection: "column", gap: vars.space[4] }}>
        <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.bold }}>Your details</h2>
        {/* One mounted region per tone, so each message is announced. */}
        <FormAlert>{alert?.tone === "error" && alert.text}</FormAlert>
        <FormAlert tone="success">{alert?.tone === "success" && alert.text}</FormAlert>
        <dl style={{ display: "grid", gap: vars.space[1], fontSize: vars.text.md }}>
          <dt style={{ color: vars.color.textSubtle, fontSize: vars.text.xs }}>Email</dt>
          <dd>{user.email}</dd>
          <dt style={{ color: vars.color.textSubtle, fontSize: vars.text.xs }}>Account</dt>
          <dd>{user.roles.includes("ADMIN") ? "Student · Administrator" : "Student"}</dd>
        </dl>
        <FormField
          label="Display name"
          name="displayName"
          autoComplete="nickname"
          maxLength={50}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          required
        />
        <FormField
          label="Faculty (optional)"
          name="faculty"
          autoComplete="organization-title"
          maxLength={100}
          value={faculty}
          onChange={(e) => setFaculty(e.target.value)}
          error={errors.faculty}
        />
        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="field-label">How should we contact you?</legend>
          <div style={{ display: "flex", gap: vars.space[4], fontSize: vars.text.md }}>
            {(
              [
                ["IN_APP", "In the app"],
                ["EMAIL", "By email"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                style={{
                  display: "inline-flex",
                  gap: vars.space[2],
                  alignItems: "center",
                  minHeight: vars.size.control,
                }}
              >
                <input
                  type="radio"
                  name="contactPreference"
                  value={value}
                  checked={contact === value}
                  onChange={() => setContact(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
