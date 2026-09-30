/**
 * The design tokens, carried from the D1 deck. This file is the source of truth: `tokens.css` is
 * generated from it (`bun run generate`), so components use `var(--color-primary)` in CSS or
 * `vars.color.primary` inline. Raw `values` are only for places CSS variables cannot reach, such as
 * page metadata and generated images.
 */
export const values = {
  color: {
    primary: "#05417e",
    onPrimary: "#ffffff",
    accent: "#ef7c00",
    text: "#0f172a",
    textMuted: "#475569",
    textSubtle: "#64748b",
    border: "#e2e8f0",
    surface: "#ffffff",
    page: "#f1f5f9",
    overlay: "rgb(15 23 42 / 0.4)",
    info: "#1e40af",
    infoSurface: "#dbeafe",
    success: "#166534",
    successSurface: "#dcfce7",
    warning: "#92400e",
    warningSurface: "#fef3c7",
    danger: "#b91c1c",
    dangerSurface: "#fee2e2",
  },
  space: {
    1: "4px",
    2: "8px",
    3: "12px",
    4: "16px",
    5: "24px",
    6: "32px",
    7: "40px",
    8: "48px",
  },
  radius: {
    sm: "8px",
    md: "16px",
    pill: "999px",
  },
  font: {
    content: '"Inter", system-ui, sans-serif',
    display: '"Roboto", system-ui, sans-serif',
  },
  text: {
    xs: "12px",
    sm: "13px",
    md: "14px",
    lg: "16px",
    xl: "18px",
    "2xl": "22px",
    "3xl": "28px",
    "4xl": "36px",
  },
  weight: {
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  shadow: {
    sm: "0 1px 2px rgb(15 23 42 / 0.12)",
    md: "0 1px 3px rgb(15 23 42 / 0.08)",
  },
  size: {
    control: "44px",
    appBar: "64px",
    topBar: "72px",
    sidebar: "240px",
    phone: "412px",
    form: "420px",
    content: "1120px",
  },
} as const;

/**
 * Mobile-first widths: base styles hold from `sm` (the narrowest supported phone), `md` and `lg` are
 * `min-width` media queries. CSS cannot read variables in a media query, so they repeat these numbers.
 */
export const breakpoints = { sm: 360, md: 768, lg: 1440 } as const;

type Values = typeof values;
type Vars = { [G in keyof Values]: { [K in keyof Values[G]]: string } };

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const cssVarName = (group: string, key: string) => `--${group}-${kebab(key)}`;

export const vars = Object.fromEntries(
  Object.entries(values).map(([group, scale]) => [
    group,
    Object.fromEntries(Object.keys(scale).map((key) => [key, `var(${cssVarName(group, key)})`])),
  ]),
) as Vars;
