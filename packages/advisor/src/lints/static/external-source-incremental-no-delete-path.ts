import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `.source({ mode: "incremental" })` table that declares neither a
 * `reconcileEveryMs` sweep nor a `softDeleteColumn` (plan 136).
 *
 * Incremental ingest pulls only rows past a watermark, so an upstream **delete**
 * is invisible to it — the deleted row simply stops appearing in the changed-rows
 * slice, and the locally-materialized copy lingers forever. Over time the table
 * fills with phantom rows that no longer exist upstream, which `defineShape` then
 * serves to clients as live data. That is silent data corruption, so it is an
 * `ERROR` (STOP) that fails the build.
 *
 * The fix is a declared delete-visibility path: `reconcileEveryMs` (a periodic
 * full-pull sweep that GCs vanished rows) or `softDeleteColumn` (an upstream
 * tombstone column the incremental pull returns, turned into a local delete).
 *
 * `defineSchema` throws on this exact condition too — this lint is the build-time
 * mirror (same belt-and-suspenders as `external_source_unscoped`), and it also
 * covers the `unanalyzable` config case the runtime guard can't see.
 *
 * **Evidence supply**: reads `table.externalSource.{mode,hasReconcile,hasSoftDelete}`
 * (the codegen feeder captures them from `.source({...})`; the runtime feeder
 * derives them). A non-incremental source, or one with either delete path, is skipped.
 */
const externalSourceIncrementalNoDeletePath: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `.source({ mode: 'incremental' })` table declares no delete-visibility path (`reconcileEveryMs` or `softDeleteColumn`), so upstream deletes are never applied and the materialized table accumulates phantom rows.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "external_source_incremental_no_delete_path",
    remediation:
        "Add `reconcileEveryMs` (a periodic full-pull sweep that GCs vanished rows) or `softDeleteColumn` (an upstream tombstone column the incremental pull returns). Incremental ingest can't see a delete otherwise.",
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            const source = table.externalSource;

            if (source === undefined) {
                continue;
            }

            if (source.unanalyzable) {
                // `.source(buildConfig())`: the config isn't a static object literal,
                // so we can't confirm the mode or the delete path. We can't prove the
                // hole either, so WARN (verify by hand) rather than the build-failing
                // ERROR the confirmed case gets.
                findings.push(
                    emit(externalSourceIncrementalNoDeletePath, {
                        cacheKey: `external_source_incremental_no_delete_path:${table.name}`,
                        detail: `Table \`${table.name}\`'s \`.source(...)\` config is not a static object literal, so its \`mode\`/delete-visibility can't be verified. If it is \`mode: "incremental"\`, confirm it declares \`reconcileEveryMs\` or \`softDeleteColumn\` — an incremental source without one accumulates phantom rows on every upstream delete.`,
                        level: "WARN",
                        metadata: { table: table.name },
                    }),
                );

                continue;
            }

            if (source.mode !== "incremental" || source.hasReconcile || source.hasSoftDelete) {
                continue;
            }

            findings.push(
                emit(externalSourceIncrementalNoDeletePath, {
                    cacheKey: `external_source_incremental_no_delete_path:${table.name}`,
                    detail: `Table \`${table.name}\` is \`.source({ mode: "incremental" })\` but declares neither \`reconcileEveryMs\` nor \`softDeleteColumn\` — an incremental pull never sees upstream deletes, so the materialized table would accumulate phantom rows. Add one of the two delete-visibility paths.`,
                    metadata: { table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Incremental sourced table has no delete-visibility path",
};

export default externalSourceIncrementalNoDeletePath;
