"use client";

import { createContext, use, useMemo, type ReactNode } from "react";
import { adminApi, type DirectoryEntry } from "@/lib/admin-api";
import { shortId, type Namer } from "@/lib/admin-labels";
import { useAdminData } from "./use-admin-data";

const PAGE = 100;
/** Enough for a campus deployment; beyond it, accounts show by id. */
const MAX_PAGES = 20;

type Directory = {
  ready: boolean;
  /** Every account loaded, by id (lower case). */
  byId: ReadonlyMap<string, DirectoryEntry>;
  /** Administrators who are active: the people who can approve a role change. */
  activeAdmins: DirectoryEntry[];
  /** "alex@u.nus.edu", or "account 0198a1c2" when the account is not loaded. */
  name: Namer;
  /** An account by its exact email or id. */
  find: (text: string) => DirectoryEntry | undefined;
  reload: () => void;
};

const DirectoryContext = createContext<Directory | null>(null);

async function everyAccount(token: string): Promise<DirectoryEntry[]> {
  const all: DirectoryEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await adminApi.directory(token, { page, pageSize: PAGE });
    all.push(...res.items);
    if (res.items.length < PAGE || all.length >= res.total) break;
  }
  return all;
}

/**
 * Names accounts across the console. It reads the directory — email, name, roles and status, no
 * profile — which is not recorded per account (ADR 0008); opening each account, or listing full
 * records, would record a read of every name on screen.
 */
export function DirectoryProvider({ children }: { children: ReactNode }) {
  const accounts = useAdminData("directory", everyAccount);
  const { data, reload } = accounts;

  const value = useMemo<Directory>(() => {
    const byId = new Map((data ?? []).map((u) => [u.id.toLowerCase(), u]));
    const byEmail = new Map((data ?? []).map((u) => [u.email.toLowerCase(), u]));
    return {
      ready: data !== undefined,
      byId,
      activeAdmins: (data ?? []).filter((u) => u.roles.includes("ADMIN") && u.status === "ACTIVE"),
      name: (id) => {
        if (typeof id !== "string") return "an unknown account";
        return byId.get(id.toLowerCase())?.email ?? `account ${shortId(id)}`;
      },
      find: (text) => {
        const key = text.trim().toLowerCase();
        return byEmail.get(key) ?? byId.get(key);
      },
      reload,
    };
  }, [data, reload]);

  return <DirectoryContext value={value}>{children}</DirectoryContext>;
}

export function useDirectory(): Directory {
  const directory = use(DirectoryContext);
  if (!directory) throw new Error("useDirectory must be used within DirectoryProvider");
  return directory;
}
