import type { Metadata, Viewport } from "next";
import "@/styles/tokens.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { values } from "@/styles/tokens";

export const metadata: Metadata = {
  title: "NUQueSt",
  description: "Campus errands, run by students.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "NUQueSt",
  },
};

export const viewport: Viewport = {
  themeColor: values.color.primary,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <StoreProvider>{children}</StoreProvider>
        </AuthProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
