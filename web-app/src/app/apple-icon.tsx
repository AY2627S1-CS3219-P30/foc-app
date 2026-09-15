import { ImageResponse } from "next/og";
import { iconMarkup } from "@/lib/pwa-icon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const { style, children } = iconMarkup(180);
  return new ImageResponse(<div style={style}>{children}</div>, size);
}
