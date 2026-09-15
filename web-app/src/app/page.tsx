"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";

export default function Home() {
  const { state } = useStore();
  const router = useRouter();

  useEffect(() => {
    router.replace(state.isAuthenticated ? "/feed" : "/login");
  }, [state.isAuthenticated, router]);

  return null;
}
