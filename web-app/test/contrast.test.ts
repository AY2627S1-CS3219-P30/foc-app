import { describe, expect, it } from "bun:test";
import { values } from "../src/styles/tokens";

/**
 * UI-NFR2.1.1 (#166): contrast of the design tokens, computed as WCAG 2.1 defines it. axe checks
 * text on the rendered screens (4.5:1); it does not check what WCAG 1.4.11 asks of everything else,
 * 3:1 for a control's boundary, a state indicator, the focus ring and icons, so this does, from the
 * tokens those are drawn with. The app has one theme (no dark mode), so each pair is checked once.
 */
type Color = keyof typeof values.color;

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** [what is drawn, in this token, on this one] for every non-text indicator the app draws. */
const NON_TEXT: [string, Color, Color][] = [
  ["text field, select and text area border", "controlBorder", "surface"],
  ["text field border on a phone screen's page", "controlBorder", "page"],
  ["invalid field border", "danger", "surface"],
  ["focus ring on the page", "primary", "page"],
  ["focus ring on a card or panel", "primary", "surface"],
  ["focus ring on the phone app bar", "onPrimary", "primary"],
  ["select chevron", "textMuted", "surface"],
  ["chosen mode ring against the switch track", "primary", "border"],
  ["selected filter chip against an unselected one", "primary", "border"],
  ["slider thumb and filled track (accent-color)", "primary", "surface"],
  ["app bar icons (menu, back, add)", "onPrimary", "primary"],
  ["back arrow and list chevrons", "text", "surface"],
];

/** Text tokens, on the backgrounds they sit on; axe checks the screens, this keeps the tokens honest. */
const TEXT: [Color, Color][] = [
  ["text", "surface"],
  ["text", "page"],
  ["textMuted", "surface"],
  ["textMuted", "page"],
  ["textMuted", "border"],
  ["textSubtle", "surface"],
  ["textSubtle", "page"],
  ["primary", "surface"],
  ["onPrimary", "primary"],
  ["text", "accent"],
  ["info", "infoSurface"],
  ["success", "successSurface"],
  ["warning", "warningSurface"],
  ["danger", "dangerSurface"],
  ["danger", "surface"],
  ["warning", "surface"],
  ["success", "surface"],
];

describe("design token contrast", () => {
  it("computes the WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it.each(NON_TEXT)("%s meets 3:1 (WCAG 1.4.11)", (_, fg, bg) => {
    expect(contrast(values.color[fg], values.color[bg])).toBeGreaterThanOrEqual(3);
  });

  it.each(TEXT)("%s text on %s meets 4.5:1", (fg, bg) => {
    expect(contrast(values.color[fg], values.color[bg])).toBeGreaterThanOrEqual(4.5);
  });
});
