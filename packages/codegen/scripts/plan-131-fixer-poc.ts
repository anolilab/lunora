/**
 * THROWAWAY PROTOTYPE — Plan 131 (advisor autofix + baseline design spike).
 *
 * Not part of `@lunora/codegen`'s public API (nothing under `src/index.ts`
 * imports this directory) — lives under `scripts/`, outside `src/` and outside
 * the package's `tsconfig.json` `include`, so it is neither type-checked as
 * part of `tsc --noEmit` nor bundled into `dist/` by packem. It exists only to
 * prove, end-to-end, that ONE AUTOFIX-SAFE lint (`unindexed_foreign_key`) can
 * be mechanically fixed and that the fix is Prettier-stable and makes the
 * advisor finding disappear on re-run. See `plans/131-phase0-design.md` for
 * the design this de-risks.
 *
 * SELF-FIXTURING: the PoC copies `apps/playground` to a temp directory,
 * injects the unindexed-FK fixture (a `.relations()` clause on `channels`,
 * whose `createdBy: v.id("users")` column exists in the real schema) into the
 * TEMP copy, and runs the before/fix/after loop there. Running it never
 * touches the repository working tree.
 *
 * Run with: `node --experimental-strip-types packages/codegen/scripts/plan-131-fixer-poc.ts`
 * (requires `pnpm run build:packages` first — no `tsconfig` `paths` hack maps
 * `@lunora/codegen` to source here, unlike when this lived under `src/`.)
 *
 * Safe to delete — do not import from here in real code.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Finding } from "@lunora/advisor";
// NOTE: this throwaway script runs directly via `node --experimental-strip-types`
// (Node's real ESM resolver, not the bundler-mode resolver the rest of this
// package's real source uses). Reaching into `../src/run-codegen` (source)
// hits that file's own extension-less relative imports, which Node's loader
// can't resolve without a build step. So the PoC instead self-imports the
// package's own *built* public entry (`@lunora/codegen`, already built via
// `pnpm run build:packages`) via Node's self-referencing-package resolution
// (package.json declares "name" + "exports", no node_modules symlink
// needed) — which is also more representative of how a real fixer feature
// would consume codegen (through its public API, not internal source). This
// script lives under `scripts/`, outside the package `tsconfig.json`
// `include`, so `tsc --noEmit` never has to resolve this self-import at all —
// no `paths` hack needed (unlike when this lived under `src/`).
import { runCodegen } from "@lunora/codegen";
import { format, resolveConfig } from "prettier";
import type { PropertyAssignment } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

// `import.meta.dirname` needs Node ^22.16/^24.0; the workspace floor is
// ^22.15.0, so resolve the throwaway script's own directory the portable way.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, "../../../apps/playground");
const TARGET_CACHE_KEY_PREFIX = "unindexed_foreign_key:channels:createdBy";
/** Directories never copied into the temp fixture (heavy or machine-local state). */
const SKIP_DIRS = new Set([".lunora", "dist", "node_modules"]);

/** Minimal shape this PoC needs out of `unindexed_foreign_key`'s `metadata.suggestedIndex`. */
interface SuggestedIndex {
    fields: ReadonlyArray<string>;
    name: string;
}

const findTargetFinding = (findings: ReadonlyArray<Finding>): Finding | undefined =>
    findings.find((finding) => finding.cacheKey.startsWith(TARGET_CACHE_KEY_PREFIX));

/**
 * Mechanically AST-append `chainCallText` onto the `defineTable(...)` chain for
 * `tableName` inside `defineSchema({ ... })`. Mirrors the technique in
 * `.vis/templates/_helpers/insert-table.ts` (in-memory ts-morph Project,
 * string-append onto the initializer, `setInitializer`, re-serialize).
 *
 * Idempotent: if the chain already contains `presenceProbe` this is a no-op.
 */
const appendChainCall = (source: string, tableName: string, chainCallText: string, presenceProbe: string): { changed: boolean; text: string } => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", source, { overwrite: true });

    const defineSchemaCall = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => call.getExpression().getText() === "defineSchema");

    if (!defineSchemaCall) {
        throw new Error("appendChainCall: no defineSchema(...) call found");
    }

    const tablesArgument = defineSchemaCall.getArguments()[0];

    if (tablesArgument === undefined) {
        throw new Error("appendChainCall: defineSchema(...) has no argument");
    }

    const tablesObject = tablesArgument.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const property = tablesObject
        .getProperties()
        .filter((candidate) => candidate.getKind() === SyntaxKind.PropertyAssignment)
        .map((candidate) => candidate as PropertyAssignment)
        .find((assignment) => assignment.getNameNode().getText() === tableName);

    if (!property) {
        throw new Error(`appendChainCall: no table "${tableName}" found in defineSchema({...})`);
    }

    const initializer = property.getInitializerOrThrow();
    const currentText = initializer.getText();

    if (currentText.includes(presenceProbe)) {
        return { changed: false, text: sourceFile.getFullText() };
    }

    property.setInitializer(`${currentText}${chainCallText}`);

    return { changed: true, text: sourceFile.getFullText() };
};

/** The fix the real fixer would apply: append `.index(name, fields)` from `metadata.suggestedIndex`. */
const appendIndexFix = (source: string, tableName: string, suggested: SuggestedIndex): { changed: boolean; text: string } =>
    appendChainCall(
        source,
        tableName,
        `.index(${JSON.stringify(suggested.name)}, ${JSON.stringify(suggested.fields)})`,
        `.index(${JSON.stringify(suggested.name)}`,
    );

/** The fixture that CREATES the finding: a relation on `channels.createdBy` with no covering index. */
const appendRelationFixture = (source: string): { changed: boolean; text: string } =>
    appendChainCall(source, "channels", `.relations((r) => ({ creator: r.one("users", { field: "createdBy" }) }))`, ".relations(");

/* eslint-disable no-console -- this is a stdout-reporting CLI-style PoC script, not library code. */
const main = async (): Promise<void> => {
    console.log("=== Plan 131 fixer PoC: unindexed_foreign_key on a temp copy of apps/playground ===\n");

    // 0. FIXTURE: copy the playground to a temp root and inject the unindexed
    // FK relation there — the repo working tree is never written to.
    const workRoot = mkdtempSync(join(tmpdir(), "plan-131-fixer-poc-"));

    try {
        cpSync(SOURCE_ROOT, workRoot, { filter: (source) => !SKIP_DIRS.has(basename(source)), recursive: true });

        const schemaPath = join(workRoot, "lunora/schema.ts");
        const fixture = appendRelationFixture(readFileSync(schemaPath, "utf8"));

        if (!fixture.changed) {
            throw new Error("fixture injection was a no-op — the playground schema already declares .relations() on channels");
        }

        writeFileSync(schemaPath, fixture.text, "utf8");
        console.log(`Fixture: temp copy at ${workRoot}, .relations() injected on channels.\n`);

        // 1. BEFORE: run codegen, capture the fabricated finding.
        const before = runCodegen({ projectRoot: workRoot });
        const beforeFinding = findTargetFinding(before.advisories);

        console.log(`Before: ${before.advisories.length.toString()} advisories, target finding present: ${String(beforeFinding !== undefined)}`);

        if (beforeFinding === undefined) {
            throw new Error("target finding not present after fixture injection — advisor behavior changed?");
        }

        const suggested = beforeFinding.metadata["suggestedIndex"] as SuggestedIndex;
        const table = beforeFinding.metadata["table"] as string;

        console.log(`  cacheKey: ${beforeFinding.cacheKey}`);
        console.log(`  metadata.suggestedIndex: ${JSON.stringify(suggested)}\n`);

        // 2. FIX: AST-append the suggested index, Prettier-format, write to the temp copy.
        const source = readFileSync(schemaPath, "utf8");
        const { changed, text } = appendIndexFix(source, table, suggested);

        if (!changed) {
            console.log("Fixer reported no-op (index already present) — nothing written.");

            return;
        }

        const prettierConfig = await resolveConfig(schemaPath);
        const formatted = await format(text, { ...prettierConfig, filepath: schemaPath });

        writeFileSync(schemaPath, formatted, "utf8");
        console.log(`Wrote fix to ${schemaPath}\n`);

        // 3. AFTER: re-run codegen, confirm the finding is gone; re-apply to prove idempotence.
        const after = runCodegen({ projectRoot: workRoot });
        const afterFinding = findTargetFinding(after.advisories);
        const rerun = appendIndexFix(readFileSync(schemaPath, "utf8"), table, suggested);

        console.log(`After: ${after.advisories.length.toString()} advisories, target finding present: ${String(afterFinding !== undefined)}`);
        console.log(`Idempotence: second apply changed=${String(rerun.changed)} (expected false)`);
        console.log(afterFinding === undefined && !rerun.changed ? "\nPASS — finding is gone and the fix is idempotent." : "\nFAIL");
    } finally {
        rmSync(workRoot, { force: true, recursive: true });
    }
};

await main();
