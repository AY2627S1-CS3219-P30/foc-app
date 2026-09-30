import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";
import { breakpoints } from "../src/styles/tokens";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const EXEMPT = /^(styles\/tokens\.|lib\/generated\/)/;

async function sources(pattern: string) {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob(pattern).scan(SRC)) {
    if (!EXEMPT.test(path)) files.push({ path, text: await Bun.file(SRC + path).text() });
  }
  expect(files.length).toBeGreaterThan(0);
  return files;
}

function offenders(files: { path: string; text: string }[], pattern: RegExp) {
  return files.flatMap(({ path, text }) => (text.match(pattern) ?? []).map((m) => `${path}: ${m}`));
}

describe("design values come from the tokens", () => {
  it("has no colour literals", async () => {
    expect(offenders(await sources("**/*.css"), /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/gi)).toEqual([]);
    expect(offenders(await sources("**/*.{ts,tsx}"), /["'`]#[0-9a-f]{3,8}["'`]|(?:color|background(?:Color)?|border(?:Color)?):\s*["'`][^"'`]*(?:#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\()/gi)).toEqual([]);
  });

  it("has no literal font sizes or weights", async () => {
    expect(offenders(await sources("**/*.css"), /font-(size|weight):\s*(?:\d|bold|bolder|lighter)[^;]*|font:\s*[^;]*(?:\dpx|\drem|\dem)[^;]*/g)).toEqual([]);
    expect(offenders(await sources("**/*.tsx"), /font(Size|Weight):\s*["'`]?(?:\d+|bold|bolder|lighter)/g)).toEqual([]);
  });

  it("only breaks at the locked breakpoints", async () => {
    const allowed = [breakpoints.md, breakpoints.lg].map((px) => `(min-width: ${px}px)`);
    const mediaQueries = (await sources("**/*.css")).map(({ path, text }) => ({
      path,
      text: (text.match(/@media[^{]*/g) ?? []).join("\n"),
    }));
    // Every width feature, so a max-width or a second clause beside an allowed one still fails.
    const widths = offenders(mediaQueries, /\([^()]*width[^()]*\)/g);
    expect(widths.filter((w) => !allowed.some((a) => w.endsWith(`: ${a}`)))).toEqual([]);
  });
});
