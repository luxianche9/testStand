import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = join(__dirname, "..");
const MAX_LINE = 120;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });
}

it(`keeps renderer source lines within ${MAX_LINE} characters`, () => {
  const offenders = sources(root).flatMap((path) =>
    readFileSync(path, "utf8").split(/\r?\n/).flatMap((line, index) =>
      [...line].length > MAX_LINE ? [`${relative(root, path)}:${index + 1} (${[...line].length})`] : []
    )
  );
  expect(offenders).toEqual([]);
});
