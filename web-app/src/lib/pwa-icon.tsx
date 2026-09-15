import type { CSSProperties } from "react";

export function iconMarkup(size: number): { style: CSSProperties; children: string } {
  return {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#05417e",
      color: "#ffffff",
      fontSize: size * 0.55,
      fontWeight: 700,
      fontFamily: "system-ui, sans-serif",
    },
    children: "N",
  };
}
