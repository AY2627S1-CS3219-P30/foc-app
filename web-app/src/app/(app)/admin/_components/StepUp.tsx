"use client";

import {
  createContext,
  use,
  useCallback,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { adminApi } from "@/lib/admin-api";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { createStepUpPrompt, type WithStepUp } from "@/lib/step-up";
import styles from "./admin.module.css";

const StepUpContext = createContext<WithStepUp | null>(null);

/**
 * Asks for the password when an action answers `401 STEP_UP_REQUIRED` (ADR 0008), then runs the
 * action again. Wrap every role change, approval and admin suspension in `useStepUp()`.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { authed } = useAuth();
  const [prompt] = useState(createStepUpPrompt);
  const asking = useSyncExternalStore(prompt.subscribe, prompt.isAsking, () => false);

  const confirm = useCallback(
    async (password: string) => {
      await authed((token) => adminApi.stepUp(token, password));
      prompt.answer(true);
    },
    [authed, prompt],
  );

  return (
    <StepUpContext value={prompt.withStepUp}>
      {children}
      <Dialog open={asking} title="Confirm it's you" onClose={() => prompt.answer(false)}>
        <PasswordForm onConfirm={confirm} onCancel={() => prompt.answer(false)} />
      </Dialog>
    </StepUpContext>
  );
}

export function useStepUp(): WithStepUp {
  const withStepUp = use(StepUpContext);
  if (!withStepUp) throw new Error("useStepUp must be used within StepUpProvider");
  return withStepUp;
}

function PasswordForm({
  onConfirm,
  onCancel,
}: {
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "INVALID_CREDENTIALS"
          ? "That isn't your password. Try again."
          : err instanceof ApiError
            ? err.message
            : "Couldn't check your password. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className={styles.dialogForm}>
      <p className={styles.muted}>
        This action changes who can administer the platform, so it needs your password. You
        won&apos;t be asked again for a few minutes.
      </p>
      <Field label="Your password" error={error} required>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
      </Field>
      <div className={styles.dialogActions}>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Confirm"}
        </Button>
      </div>
    </form>
  );
}
