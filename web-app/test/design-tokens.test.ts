import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { breakpoints } from "../src/styles/tokens";

const SRC = new URL("../src/", import.meta.url).pathname;
const EXEMPT = /^(styles\/tokens\.|lib\/generated\/)/;

async function sources(pattern: string) {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob(pattern).scan(SRC)) {
    if (!EXEMPT.test(path)) files.push({ path, text: await Bun.file(SRC + path).text() });
  }
  return files;
}

function offenders(files: { path: string; text: string }[], pattern: RegExp) {
  return files.flatMap(({ path, text }) => (text.match(pattern) ?? []).map((m) => `${path}: ${m}`));
}

describe("design values come from the tokens", () => {
  it("has no colour literals", async () => {
    expect(offenders(await sources("**/*.css"), /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/gi)).toEqual([]);
    expect(offenders(await sources("**/*.{ts,tsx}"), /["'`]#[0-9a-f]{3,8}["'`]/gi)).toEqual([]);
  });

  it("has no literal font sizes or weights", async () => {
    expect(offenders(await sources("**/*.css"), /font-(size|weight):\s*\d[^;]*/g)).toEqual([]);
    expect(offenders(await sources("**/*.tsx"), /font(Size|Weight):\s*\d+/g)).toEqual([]);
  });

  it("only breaks at the locked breakpoints", async () => {
    const allowed = [breakpoints.md, breakpoints.lg].map((px) => `(min-width: ${px}px)`);
    const queries = offenders(await sources("**/*.css"), /@media[^{]*width[^{]*/g);
    expect(queries.filter((q) => !allowed.some((a) => q.includes(a)))).toEqual([]);
  });
});
