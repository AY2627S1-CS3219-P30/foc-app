import type { MetadataRoute } from "next";
import { values } from "@/styles/tokens";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NUQueSt — Campus Errands",
    short_name: "NUQueSt",
    description: "Campus errands, run by students.",
    start_url: "/",
    display: "standalone",
    background_color: values.color.surface,
    theme_color: values.color.primary,
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
