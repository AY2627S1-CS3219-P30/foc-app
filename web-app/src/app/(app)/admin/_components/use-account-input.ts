"use client";

import { useState } from "react";
import { isUuid } from "@/lib/admin-labels";
import { useDirectory } from "./Directory";

/**
 * A field that names an account by email or id. `resolve()` gives the account's id, `undefined` when
 * the field is empty, or `null` — and sets `error` — when it names no account the console knows.
 */
export function useAccountInput(initial: string) {
  const { find } = useDirectory();
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();

  return {
    text,
    error,
    setText(value: string) {
      setText(value);
      setError(undefined);
    },
    resolve(): string | undefined | null {
      const value = text.trim();
      if (!value) return undefined;
      const found = find(value);
      if (found) return found.id;
      if (isUuid(value)) return value.toLowerCase();
      setError(value.includes("@") ? "No account has that email." : "Enter an email or an account id.");
      return null;
    },
  };
}
