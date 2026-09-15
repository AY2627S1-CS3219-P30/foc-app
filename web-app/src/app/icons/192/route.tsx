import { ImageResponse } from "next/og";
import { iconMarkup } from "@/lib/pwa-icon";

export async function GET() {
  const { style, children } = iconMarkup(192);
  return new ImageResponse(<div style={style}>{children}</div>, { width: 192, height: 192 });
}
