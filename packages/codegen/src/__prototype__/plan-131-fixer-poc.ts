/**
 * THROWAWAY PROTOTYPE — Plan 131 (advisor autofix + baseline design spike).
 *
 * Not part of `@lunora/codegen`'s public API (nothing under `src/index.ts`
 * imports this directory). It exists only to prove, end-to-end, that ONE
 * AUTOFIX-SAFE lint (`unindexed_foreign_key`) can be mechanically fixed in
 * `apps/playground/lunora/schema.ts` and that the fix is Prettier-stable and
 * makes the advisor finding disappear on re-run. See
 * `plans/131-phase0-design.md` for the design this de-risks.
 *
 * Run with: `node --experimental-strip-types packages/codegen/src/__prototype__/plan-131-fixer-poc.ts`
 * (Node 24 supports type-stripping natively; no build step needed.)
 *
 * Safe to delete — do not import from here in real code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Finding } from "@lunora/advisor";
// NOTE: this throwaway script runs directly via `node --experimental-strip-types`
// (Node's real ESM resolver, not the bundler-mode resolver the rest of this
// package's real source uses). Reaching into `../run-codegen` (source) hits
// that file's own extension-less relative imports, which Node's loader can't
// resolve without a build step. So the PoC instead self-imports the package's
// own *built* public entry (`@lunora/codegen`, already built via `pnpm run
// build:packages`) via Node's self-referencing-package resolution
// (package.json declares "name" + "exports", no node_modules symlink
// needed) — which is also more representative of how a real fixer feature
// would consume codegen (through its public API, not internal source).
import { runCodegen } from "@lunora/codegen";
import { format, resolveConfig } from "prettier";
import type { PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

// `import.meta.dirname` needs Node ^22.16/^24.0; the workspace floor is
// ^22.15.0, so resolve the throwaway script's own directory the portable way.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "../../../../apps/playground");
const SCHEMA_PATH = join(PROJECT_ROOT, "lunora/schema.ts");
const TARGET_CACHE_KEY_PREFIX = "unindexed_foreign_key:channels:createdBy";

/** Minimal shape this PoC needs out of `unindexed_foreign_key`'s `metadata.suggestedIndex`. */
interface SuggestedIndex {
    fields: ReadonlyArray<string>;
    name: string;
}

const findTargetFinding = (findings: ReadonlyArray<Finding>): Finding | undefined =>
    findings.find((finding) => finding.cacheKey.startsWith(TARGET_CACHE_KEY_PREFIX));

/**
 * Mechanically AST-append `.index(name, fields)` onto the `defineTable(...)`
 * chain for `tableName` inside `defineSchema({ ... })`. Mirrors the technique
 * in `.vis/templates/_helpers/insert-table.ts` (in-memory ts-morph Project,
 * string-append onto the initializer, `setInitializer`, re-serialize).
 *
 * Idempotent: if the chain already calls `.index(name, ...)` this is a no-op.
 */
const appendIndexFix = (source: string, tableName: string, suggested: SuggestedIndex): { changed: boolean; text: string } => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    const defineSchemaCall = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getText() === "defineSchema");

    if (!defineSchemaCall) {
        throw new Error("appendIndexFix: no defineSchema(...) call found");
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument === undefined) {
        throw new Error("appendIndexFix: defineSchema(...) has no argument");
    }

    const tablesObject = tablesArgument.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const property = tablesObject
        .getProperties()
        .filter((candidate) => candidate.getKind() === SyntaxKind.PropertyAssignment)
        .map((candidate) => candidate as PropertyAssignment)
        .find((assignment) => assignment.getNameNode().getText() === tableName);

    if (!property) {
        throw new Error(`appendIndexFix: no table "${tableName}" found in defineSchema({...})`);
    }

    const initializer = property.getInitializerOrThrow();
    const currentText = initializer.getText();
    const indexCallText = `.index(${JSON.stringify(suggested.name)}, ${JSON.stringify(suggested.fields)})`;

    if (currentText.includes(`.index(${JSON.stringify(suggested.name)}`)) {
        return { changed: false, text: sourceFile.getFullText() };
    }

    property.setInitializer(`${currentText}${indexCallText}`);

    return { changed: true, text: sourceFile.getFullText() };
};

/* eslint-disable no-console -- this is a stdout-reporting CLI-style PoC script, not library code. */
const main = async (): Promise<void> => {
    console.log("=== Plan 131 fixer PoC: unindexed_foreign_key on apps/playground ===\n");

    // 1. BEFORE: run codegen, capture the genuine finding.
    const before = runCodegen({ projectRoot: PROJECT_ROOT });
    const beforeFinding = findTargetFinding(before.advisories);

    console.log(`Before: ${before.advisories.length.toString()} advisories, target finding present: ${String(beforeFinding !== undefined)}`);

    if (beforeFinding === undefined) {
        console.log("Nothing to fix — target finding not present (already fixed, or .relations() edit missing). Exiting.");

        return;
    }

    const suggested = beforeFinding.metadata["suggestedIndex"] as SuggestedIndex;
    const table = beforeFinding.metadata["table"] as string;

    console.log(`  cacheKey: ${beforeFinding.cacheKey}`);
    console.log(`  metadata.suggestedIndex: ${JSON.stringify(suggested)}\n`);

    // 2. FIX: AST-append the suggested index, Prettier-format, write to disk.
    const source = readFileSync(SCHEMA_PATH, "utf8");
    const { changed, text } = appendIndexFix(source, table, suggested);

    if (!changed) {
        console.log("Fixer reported no-op (index already present) — nothing written.");

        return;
    }

    const prettierConfig = await resolveConfig(SCHEMA_PATH);
    const formatted = await format(text, { ...prettierConfig, filepath: SCHEMA_PATH });

    writeFileSync(SCHEMA_PATH, formatted, "utf8");
    console.log(`Wrote fix to ${SCHEMA_PATH}\n`);

    // 3. AFTER: re-run codegen, confirm the finding is gone.
    const after = runCodegen({ projectRoot: PROJECT_ROOT });
    const afterFinding = findTargetFinding(after.advisories);

    console.log(`After: ${after.advisories.length.toString()} advisories, target finding present: ${String(afterFinding !== undefined)}`);
    console.log(afterFinding === undefined ? "\nPASS — finding is gone after the mechanical fix." : "\nFAIL — finding still present.");
};

await main();
