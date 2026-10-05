import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The right-to-erasure purge must delete every org-scoped table.
 *
 * Its list is hand-maintained — codegen types `context.db.delete` per table, so it
 * cannot be derived at runtime — and it had drifted to 12 of 25 while the
 * function's own docblock claimed erasure "across every org-scoped table". What
 * it left behind was the worst half: `observations`, `metricPoints` and the
 * `issues`/`incidents` bodies all carry end-user data, `alertRules` keeps live
 * webhook and PagerDuty destinations for a deleted tenant, and the org's
 * envelope-encrypted Cloudflare token (then in `cloudflareBilling`, now in
 * `cloudflareAccounts`) stayed behind — orphaned, with no org row left for any
 * later sweep to key off.
 *
 * This asserts the list against the schema, so the next org-scoped table added
 * fails here rather than silently surviving an erasure request.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/** Every table module the schema composes (`lunora/schema.ts` spreads them). */
const SCHEMA = ["billing", "boxes", "deploy", "observability", "platform"].map((group) => read(`../lunora/tables/${group}.ts`)).join("\n");
const ORGANIZATIONS = read("../lunora/organizations.ts");

/** The two shapes an org-scoped column is declared in. Plain substrings — no regex to backtrack. */
const ORG_COLUMN = ['organizationId: v.id("organizations")', 'organizationId: v.optional(v.id("organizations"))'];

/** Where each `defineTable` block begins, so a column can be attributed to its table. */
const TABLE_DECLARATION = /^ {4}(?<name>\w+): defineTable\(\{/gmu;

/**
 * Every table in the schema that carries an `organizationId` column, optional or
 * not.
 *
 * Written as a fold over the table declarations rather than a loop with branches:
 * this suite's lint forbids conditionals in a test file, and the membership test
 * is a substring check, so there is no regex here to backtrack.
 */
const orgScopedTables = (): string[] => {
    const declarations = [...SCHEMA.matchAll(TABLE_DECLARATION)];

    return declarations
        .map((match, index) => {
            return {
                body: SCHEMA.slice(match.index, declarations[index + 1]?.index ?? SCHEMA.length),
                name: match.groups?.["name"] ?? "",
            };
        })
        .filter((entry) => ORG_COLUMN.some((column) => entry.body.includes(column)))
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
};

/** The literal the purge iterates. */
const purgedTables = (): string[] => {
    const block = /const orgScopedTables = \[(?<body>[^\]]*)\]/u.exec(ORGANIZATIONS);

    return [...(block?.groups?.["body"] ?? "").matchAll(/"(?<name>\w+)"/gu)]
        .map((match) => match.groups?.["name"] ?? "")
        .toSorted((a, b) => a.localeCompare(b));
};

/**
 * `deployments` is deliberately absent: the purge transitions it to `destroyed`
 * instead, so the teardown path can still reach the live dispatch script, D1 and
 * R2. Hard-deleting the row would leak all three.
 */
const HANDLED_ELSEWHERE = new Set([
    // An alias names its tenant, so it stays claimed until the teardown sweep
    // destroyed that tenant (`releaseIdleAliases`, then the sweep's `releaseAlias`):
    // purged here, another organization could claim it and deploy onto the
    // erased one's tenant and data.
    "aliasOwnership",
    "deployments",
    // Each row points at a snapshot object in R2, which a mutation cannot delete.
    // The purge deletes the org's projects; the tenant backup sweep then deletes
    // every snapshot whose project is gone, object first, then the row. Purging
    // the rows here would orphan the objects — tenant data outliving an erasure.
    "tenantBackups",
]);

describe("organizations.purgeDeleted", () => {
    it("purges every org-scoped table the schema declares", () => {
        const expected = orgScopedTables().filter((table) => !HANDLED_ELSEWHERE.has(table));
        const missing = expected.filter((table) => !purgedTables().includes(table));

        expect(missing).toStrictEqual([]);
    });

    it("does not hard-delete deployments — teardown needs the row", () => {
        expect(purgedTables()).not.toContain("deployments");
        expect(ORGANIZATIONS).toContain('status: "destroyed"');
    });

    it("releases only the alias claims whose tenant is already gone", () => {
        expect(ORGANIZATIONS).toContain("await releaseIdleAliases(context, { organizationId });");
    });

    it("purges githubInstallations, whose organizationId is optional and so is not derivable", () => {
        expect(purgedTables()).toContain("githubInstallations");
    });
});
