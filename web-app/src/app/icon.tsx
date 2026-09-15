import { ImageResponse } from "next/og";
import { iconMarkup } from "@/lib/pwa-icon";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  const { style, children } = iconMarkup(32);
  return new ImageResponse(<div style={style}>{children}</div>, size);
}
