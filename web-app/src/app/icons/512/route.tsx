import { ImageResponse } from "next/og";
import { iconMarkup } from "@/lib/pwa-icon";

export async function GET() {
  const { style, children } = iconMarkup(512);
  return new ImageResponse(<div style={style}>{children}</div>, { width: 512, height: 512 });
}
