import type { Metadata, Viewport } from "next";
import "./globals.css";
import { StoreProvider } from "@/lib/store";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

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
  themeColor: "#05417e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
