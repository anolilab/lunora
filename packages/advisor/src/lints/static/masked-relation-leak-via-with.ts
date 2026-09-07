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

/**
 * `${file} ${exportName}` → what that procedure's OWN `.use(mask(...))` policy
 * covers on a `with` hop: the set of tables the policy names, or `"all"` when
 * the policy argument was not statically readable (`usesMask` is still true, so
 * it could name any table and nothing under it may be flagged).
 *
 * The relation loader applies the READING procedure's mask to every hop, so this
 * — not the mask on the related table's own procedures — is what decides whether
 * a hydrated child comes back masked.
 */
const ownMaskCoverageOf = (context: LintContext): Map<string, "all" | Set<string>> => {
    const coverage = new Map<string, "all" | Set<string>>();

    for (const procedure of context.maskProcedures ?? []) {
        if (!procedure.usesMask) {
            continue;
        }

        const tables = new Set(procedure.maskColumns.map(({ table }) => table));

        coverage.set(`${procedure.file} ${procedure.exportName}`, tables.size === 0 ? "all" : tables);
    }

    return coverage;
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
 * Column masking is **per-procedure**, and that — not the `with` boundary — is
 * what this catches. `.use(mask(policies))` installs a `relationMask` hook on
 * the read's args (`@lunora/server`'s `mask/middleware`), and the relation
 * loader calls it for the TARGET table of every hop, at every nesting depth
 * (`@lunora/shard-engine`'s `relations`); the one hop it cannot reach, a
 * cross-shard child, fails closed with `MASK_UNSUPPORTED` rather than returning
 * cleartext. So a procedure that masks `users` gets masked `users` through
 * `with` too.
 *
 * What is still real is a read whose OWN procedure declares no policy for the
 * related table. `ctx.db.posts.findMany({ with: { author: true } })` in a
 * procedure with no `.use(mask(...))` — or one whose policy names only `posts` —
 * hands back every `author` in the clear, including the columns another
 * procedure carefully masks on `users`' own reads. Nothing about the mask on
 * `users` reaches this read.
 *
 * INFO, near-zero false positives by construction: it fires only when all of
 * (1) the enclosing read is public, (2) the read declares `with: { <rel> }`,
 * (3) `<rel>` resolves through the schema to a real target table, (4) that
 * target table actually has masked columns (per the discovered mask evidence),
 * and (5) the reading procedure's own mask policy does not cover that target
 * table. A policy this feeder could not read statically counts as covering
 * everything, so an opaque `mask(policies)` never produces a finding.
 * Absent any mask usage the lint is a no-op. Runs only when the codegen feeder
 * supplies `context.relationLoads`; a runtime caller flags nothing. One finding
 * per `(read, masked relation)` pair.
 */
const maskedRelationLeakViaWith: Lint = {
    categories: ["SECURITY"],
    description:
        "A public read hydrates a masked table through a `with` relation, from a procedure whose own mask policy does not cover that table. Masking is per-procedure — the relation loader applies the READING procedure's policy to every hop — so a table masked only on its own reads comes back in the clear here.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "masked_relation_leak_via_with",
    remediation:
        "Add the related table to this read's own `.use(mask({ … }))` policy — the relation loader applies it to every `with` hop, so one policy covers the parent and its children. Alternatively drop the relation or project only non-sensitive columns. A mask declared on the related table's own procedures does not carry over: masking is per-procedure.",
    run: (context) => {
        if (context.relationLoads === undefined) {
            return [];
        }

        const maskedTables = maskedTablesOf(context);

        if (maskedTables.size === 0) {
            return [];
        }

        const relationTargets = relationTargetsOf(context);
        const ownMaskCoverage = ownMaskCoverageOf(context);
        const findings: Finding[] = [];

        for (const row of context.relationLoads) {
            if (row.visibility !== "public" || row.parentTable === "") {
                continue;
            }

            const covered = ownMaskCoverage.get(`${row.file} ${row.exportName}`);

            for (const relation of row.relations) {
                const target = relationTargets.get(`${row.parentTable} ${relation}`);

                if (target === undefined || !maskedTables.has(target)) {
                    continue;
                }

                // This read's own policy already masks the hop's target table,
                // so the loader hands the child back masked.
                if (covered === "all" || covered?.has(target) === true) {
                    continue;
                }

                findings.push(
                    emit(maskedRelationLeakViaWith, {
                        cacheKey: `masked_relation_leak_via_with:${row.file}:${row.line.toString()}:${row.parentTable}:${relation}`,
                        detail: `The public read in \`${row.exportName}\` (${row.file}:${row.line.toString()}) hydrates relation \`${relation}\` (masked table \`${target}\`) via \`with\` on \`${row.parentTable}\`, and its own mask policy does not cover \`${target}\`. Masking is per-procedure, so \`${target}\`'s masked columns are returned in the clear here.`,
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
