// Turns packages/contracts/openapi.json (written by python/scripts/generate_operations.py) into
// src/openapi.generated.ts with openapi-typescript. Run by that script; `--check` exits 1 when the
// committed file is stale.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

const source = new URL("../openapi.json", import.meta.url);
const target = new URL("../src/openapi.generated.ts", import.meta.url);
const header = "// Generated from openapi.json by scripts/generate-openapi-types.mjs. Do not edit.\n";

/** Bytes travel as base64 but the client hands them over as `Uint8Array`; a free-form JSON object
 *  takes any object, interfaces included. */
function transform(schema) {
  if (schema.contentEncoding === "base64" || schema.format === "base64url") return ts.factory.createTypeReferenceNode("Uint8Array");
  if (schema.type === "object" && schema.additionalProperties === true && !schema.properties) {
    return ts.factory.createKeywordTypeNode(ts.SyntaxKind.ObjectKeyword);
  }
  return undefined;
}

const document = JSON.parse(await readFile(source, "utf8"));
const output = header + astToString(await openapiTS(document, { transform, alphabetize: true, defaultNonNullable: false }));
if (!process.argv.includes("--check")) await writeFile(target, output);
else if (output !== await readFile(target, "utf8").catch(() => "")) {
  console.error(`${fileURLToPath(target)} is stale; run python/scripts/generate_operations.py`);
  process.exit(1);
}
