"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Menu } from "@/components/Menu";
import { useStore } from "@/lib/store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { state } = useStore();
  const router = useRouter();

  useEffect(() => {
    if (!state.isAuthenticated) router.replace("/login");
  }, [state.isAuthenticated, router]);

  if (!state.isAuthenticated) return null;

  return (
    <>
      {children}
      <Menu />
    </>
  );
}
