import emit from "../../finding";
import type { Finding, Lint, LintContext } from "../../types";

/** Every table that has at least one masked column, gathered from both mask evidence sources. */
const maskedTablesOf = (context: LintContext): Set<string> => {
    const tables = new Set<string>();

    for (const procedure of context.maskProcedures ?? []) {
        for (const { table } of procedure.maskColumns) {
            if (table !== "") {
                tables.add(table);
            }
        }
    }

    for (const strategy of context.maskStrategies ?? []) {
        if (strategy.table !== "") {
            tables.add(strategy.table);
        }
    }

    return tables;
};

/** `${parentTable} ${relationAccessor}` → the relation's target table, for every declared relation in the schema. */
const relationTargetsOf = (context: LintContext): Map<string, string> => {
    const targets = new Map<string, string>();

    for (const table of context.schema.tables) {
        for (const relation of table.relations) {
            targets.set(`${table.name} ${relation.name}`, relation.table);
        }
    }

    return targets;
};

/**
 * Flags a public read that hydrates a masked table's rows in the clear through a
 * `with` relation.
 *
 * Column masking (`.use(mask(...))`) is applied per-procedure to the *top-level*
 * rows of the table named in a read. It does **not** descend into relations
 * hydrated via `with` — `ctx.db.posts.findMany({ with: { author: true } })`
 * returns each `author` fully unmasked even when the `users` table is masked
 * elsewhere. So a table whose columns you carefully mask on its own reads is
 * still served in the clear whenever an unprotected parent read pulls it in as a
 * relation.
 *
 * INFO, near-zero false positives by construction: it fires only when all of
 * (1) the enclosing read is public, (2) the read declares `with: { <rel> }`,
 * (3) `<rel>` resolves through the schema to a real target table, and (4) that
 * target table actually has masked columns (per the discovered mask evidence).
 * Absent any mask usage the lint is a no-op. Runs only when the codegen feeder
 * supplies `context.relationLoads`; a runtime caller flags nothing. One finding
 * per `(read, masked relation)` pair.
 */
const maskedRelationLeakViaWith: Lint = {
    categories: ["SECURITY"],
    description:
        "A public read hydrates a masked table through a `with` relation. Column masking does not descend into `with`-hydrated relations, so the related table's masked columns are returned in the clear.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "masked_relation_leak_via_with",
    remediation:
        "Don't hydrate a masked table through `with` on an unprotected read: drop the relation, project only non-sensitive columns, or route the parent read through a procedure that re-applies masking to the joined table. Masking is per-procedure and top-level only — it never reaches `with`-loaded relations.",
    run: (context) => {
        if (context.relationLoads === undefined) {
            return [];
        }

        const maskedTables = maskedTablesOf(context);

        if (maskedTables.size === 0) {
            return [];
        }

        const relationTargets = relationTargetsOf(context);
        const findings: Finding[] = [];

        for (const row of context.relationLoads) {
            if (row.visibility !== "public" || row.parentTable === "") {
                continue;
            }

            for (const relation of row.relations) {
                const target = relationTargets.get(`${row.parentTable} ${relation}`);

                if (target === undefined || !maskedTables.has(target)) {
                    continue;
                }

                findings.push(
                    emit(maskedRelationLeakViaWith, {
                        cacheKey: `masked_relation_leak_via_with:${row.file}:${row.line.toString()}:${row.parentTable}:${relation}`,
                        detail: `The public read in \`${row.exportName}\` (${row.file}:${row.line.toString()}) hydrates relation \`${relation}\` (masked table \`${target}\`) via \`with\` on \`${row.parentTable}\`. Masking is top-level only and does not descend into \`with\`, so \`${target}\`'s masked columns are returned in the clear.`,
                        metadata: {
                            exportName: row.exportName,
                            file: row.file,
                            line: row.line,
                            parentTable: row.parentTable,
                            relation,
                            relationTable: target,
                        },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Masked table surfaced unmasked through a with-relation on a public read",
};

export default maskedRelationLeakViaWith;
