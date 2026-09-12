/**
 * Drift gate for the payment tables the `payment` registry item re-declares.
 *
 * `registry/payment/schema.ts` is a hand-maintained copy of
 * `packages/payment/src/schema.ts` — it has to be, because `lunora registry add
 * payment` scaffolds it into a project that declares the tables INLINE (codegen
 * parses `lunora/schema.ts` as an AST, so a cross-package
 * `defineSchema({ ...paymentTables })` spread is silently skipped). Its own
 * docstring claims the columns "mirror `@lunora/payment`'s exported
 * `paymentTables`, which is the canonical reference".
 *
 * Nothing compared them. `priceIds` landed on the canonical `subscriptions`
 * table and never reached the copy, so every project scaffolded by the item got
 * SINGLE-ITEM entitlements: `hasActivePrice` and `resolveEntitlements` test
 * membership in `priceIds` (falling back to `[priceId]` when absent), and a
 * Stripe subscription billing a base plan alongside an add-on or a metered price
 * has a `priceId` naming only one of them. The canonical column says as much —
 * "Apps that mirror these tables inline must add the column to get multi-item
 * entitlements."
 *
 * A source-text comparison rather than an import, because the point of the copy
 * is that a scaffolded project must not depend on `@lunora/payment` to declare
 * its own schema.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/** Repo root — resolved by walking up from the vitest project root, which differs per invocation. */
const repoRoot = (): string => {
    let directory = process.cwd();

    while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
        const parent = dirname(directory);

        if (parent === directory) {
            throw new Error("cannot locate the repo root (no pnpm-workspace.yaml above the vitest project root)");
        }

        directory = parent;
    }

    return directory;
};

const stripComments = (source: string): string => source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^[\t ]*\/\/[^\n]*$/gmu, "");

/**
 * The column names one `defineTable({ … })` call declares, in source order.
 *
 * Scans balanced braces from the call's `{` and collects `name:` at depth 1
 * only, so a nested `v.object({ … })` column or an index's options object
 * contributes nothing. Both files spell the call the same way — `<name> =
 * defineTable({` at module scope, or `<name>: defineTable({` inside an object
 * literal — so one pattern covers both.
 */
const columnsOf = (relativePath: string, table: string): string[] => {
    const source = stripComments(readFileSync(join(repoRoot(), relativePath), "utf8"));
    const call = new RegExp(String.raw`\b${table}\s*[:=]\s*defineTable\(\s*\{`, "u").exec(source);

    if (call === null) {
        throw new Error(`${relativePath}: no \`defineTable\` call for "${table}" — the table was renamed or the copy moved.`);
    }

    const open = call.index + call[0].length - 1;
    const columns: string[] = [];
    let depth = 0;

    for (let index = open; index < source.length; index += 1) {
        const character = source[index];

        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;

            if (depth === 0) {
                return columns;
            }
        } else if (depth === 1) {
            // A column key is the first identifier after `{` or `,` at this depth.
            const ahead = /^([A-Za-z_$][\w$]*)\s*:/u.exec(source.slice(index));
            const previous = source.slice(0, index).trimEnd().at(-1);

            if (ahead && (previous === "{" || previous === ",")) {
                columns.push(ahead[1] as string);
                index += ahead[0].length - 1;
            }
        }
    }

    throw new Error(`${relativePath}: unbalanced braces in the \`${table}\` table declaration.`);
};

const CANONICAL = "packages/payment/src/schema.ts";
const COPY = "registry/payment/schema.ts";

/** The five tables the store reads and writes — named in both files' docstrings. */
const TABLES = ["customers", "events", "paymentSessions", "subscriptions", "usageEvents"];

describe("payment registry item mirrors the canonical tables", () => {
    it.each(TABLES)("%s declares the same columns as @lunora/payment", (table) => {
        expect.assertions(1);

        expect(columnsOf(COPY, table)).toStrictEqual(columnsOf(CANONICAL, table));
    });

    it("reads a non-trivial column set (the scanner is not vacuously passing)", () => {
        expect.assertions(2);

        // A brace-scanner that silently returned `[]` would make every case above
        // pass against anything. Pin one known column and a plausible count.
        expect(columnsOf(CANONICAL, "subscriptions")).toContain("priceIds");
        expect(columnsOf(CANONICAL, "subscriptions").length).toBeGreaterThan(8);
    });
});
