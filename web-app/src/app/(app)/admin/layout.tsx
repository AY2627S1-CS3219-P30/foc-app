"use client";

import Link from "next/link";
import { buttonClass } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { EmptyState } from "@/components/States";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { DirectoryProvider } from "./_components/Directory";
import { StepUpProvider } from "./_components/StepUp";

/**
 * The admin console (ADM-02). The (app) layout has already made sure someone is signed in; this one
 * shows the console to administrators only. That is presentation: every endpoint the console calls
 * refuses a student with `403` on its own.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  if (!user?.roles.includes("ADMIN")) {
    return (
      <DesktopShell navItems={STUDENT_NAV} activeHref="/admin" heading="Administrators only">
        <EmptyState
          title="This area is for administrators"
          action={
            <Link href="/feed" className={buttonClass({ variant: "outline" })}>
              Back to the request feed
            </Link>
          }
        >
          Your account doesn&apos;t have the administrator role, so the admin console isn&apos;t
          available to you.
        </EmptyState>
      </DesktopShell>
    );
  }

  return (
    <StepUpProvider>
      <DirectoryProvider>{children}</DirectoryProvider>
    </StepUpProvider>
  );
}
