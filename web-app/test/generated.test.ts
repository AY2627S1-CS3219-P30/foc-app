import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { generatedFiles } from "../scripts/generate";

const files = Object.entries(await generatedFiles());

it.each(files)("%s is up to date (run `bun run generate`)", async (path, expected) => {
  expect(await readFile(new URL(`../${path}`, import.meta.url), "utf8")).toBe(expected);
});
