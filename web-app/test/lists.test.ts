import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// globals.css sets every element's padding to 0 but leaves list markers on, so a list nobody styled
// draws its bullets or numbers outside its own box, past the edge of the card it sits in (the ledger
// audit's checks did). A list in a component therefore always says how it looks.
describe("lists", () => {
  it("give every <ul> and <ol> a class or a style", async () => {
    const bare: string[] = [];
    for await (const path of new Glob("**/*.tsx").scan(SRC)) {
      const text = await Bun.file(SRC + path).text();
      for (const match of text.matchAll(/<(ul|ol)>/g)) bare.push(`${path}: <${match[1]}>`);
    }
    expect(bare).toEqual([]);
  });
});
