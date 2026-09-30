import type { CSSProperties } from "react";
import { values } from "@/styles/tokens";

export function iconMarkup(size: number): { style: CSSProperties; children: string } {
  return {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: values.color.primary,
      color: values.color.onPrimary,
      fontSize: size * 0.55,
      fontWeight: Number(values.weight.bold),
      fontFamily: "system-ui, sans-serif",
    },
    children: "N",
  };
}
