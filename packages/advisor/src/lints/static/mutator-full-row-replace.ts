import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a custom mutator whose authoritative `server` impl writes a row with
 * `ctx.db.replace(id, document)` — a whole-document overwrite.
 *
 * The local-first sync engine serializes mutators in the shard DO, so two
 * mutators that touch the *same row* but *different columns* both run to
 * completion — but only if each writes its own column. A `replace` overwrites
 * the entire row from the document the mutator assembled, so a concurrent edit
 * to another column (committed between this mutator's read and its write, or
 * carried as a pending optimistic overlay on a client) is silently clobbered:
 * the kind of "two offline edits to different fields fight each other" data loss
 * a column-level merge avoids. `ctx.db.patch(id, { onlyTheChangedField })`
 * merges at the column level instead, so independent field edits coexist.
 *
 * `WARN`, not `ERROR`: `replace` is legitimate when the mutator genuinely owns
 * the whole row (a full-form save, a state-machine transition that rewrites
 * every field). The lint just surfaces the column-clobber risk so a developer
 * reaches for `patch` by default on a synced table.
 *
 * **Evidence supply**: runs only when the codegen feeder supplies
 * `context.mutatorWrites` (each a `replace` call lifted from a mutator's inline
 * `server` body); absent for runtime callers, where the lint finds nothing.
 */
const mutatorFullRowReplace: Lint = {
    categories: ["SCHEMA"],
    description:
        "A custom mutator's `server` impl writes with `ctx.db.replace(id, document)` — a whole-row overwrite. On a synced table this clobbers a concurrent edit to a different column; `ctx.db.patch(id, { field })` merges at the column level so independent field edits coexist.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "mutator_full_row_replace",
    remediation:
        "Prefer `ctx.db.patch(id, { onlyTheChangedField })` so a concurrent edit to another column isn't lost. Keep `replace` only when the mutator genuinely owns the entire row (e.g. a full-form save).",
    run: (context) => {
        if (context.mutatorWrites === undefined) {
            return [];
        }

        return context.mutatorWrites.map((write) =>
            emit(mutatorFullRowReplace, {
                cacheKey: `mutator_full_row_replace:${write.exportName}:${String(write.line)}`,
                detail: `Mutator \`${write.exportName}\` (${write.file}:${String(write.line)}) writes with \`ctx.db.replace(...)\`, overwriting the whole row. A concurrent edit to a different column is clobbered — use \`ctx.db.patch(id, { field })\` to merge at the column level.`,
                metadata: { exportName: write.exportName, file: write.file, line: write.line },
            }),
        );
    },
    source: "static",
    title: "Mutator overwrites the whole row (clobbers concurrent column edits)",
};

export default mutatorFullRowReplace;
