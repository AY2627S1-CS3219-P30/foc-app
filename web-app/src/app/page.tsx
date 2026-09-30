"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    // `unavailable` goes to the app too, whose layout explains the problem and offers a retry.
    router.replace(status === "signedOut" ? "/login" : "/feed");
  }, [status, router]);

  return null;
}
