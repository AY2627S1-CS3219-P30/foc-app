import { ApiError } from "./api-client";

/** What an action fails with when the admin closes the password prompt instead of answering it. */
export const STEP_UP_CANCELLED = "STEP_UP_CANCELLED";

/**
 * The console's half of password re-entry (ADR 0008). The riskiest admin actions answer
 * `401 STEP_UP_REQUIRED` until the password has been re-entered on this session in the last few
 * minutes. `withStepUp` runs an action; if it asks for the password, `ask` shows the prompt and
 * resolves true once `POST /auth/step-up` accepted it, and the action runs again — once.
 *
 * The services check permission before the password, so an action that would be refused anyway is
 * refused without a prompt. Actions that need the password at the same moment share one prompt.
 */
export function createStepUp(ask: () => Promise<boolean>) {
  let open: Promise<boolean> | null = null;
  const prompt = () =>
    (open ??= ask().finally(() => {
      open = null;
    }));

  return async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "STEP_UP_REQUIRED") throw err;
      if (!(await prompt())) {
        throw new ApiError(0, STEP_UP_CANCELLED, "Nothing changed: your password was not re-entered.");
      }
      return action();
    }
  };
}

export type WithStepUp = ReturnType<typeof createStepUp>;

/**
 * The prompt behind {@link createStepUp}, as a store React can read with `useSyncExternalStore`:
 * `isAsking()` while the password dialog should show, `answer(ok)` once it was re-entered or cancelled.
 */
export function createStepUpPrompt() {
  let resolve: ((ok: boolean) => void) | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    withStepUp: createStepUp(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
          notify();
        }),
    ),
    isAsking: () => resolve !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    answer(ok: boolean) {
      const r = resolve;
      resolve = null;
      notify();
      r?.(ok);
    },
  };
}
