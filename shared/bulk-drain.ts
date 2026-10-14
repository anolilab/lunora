/**
 * The client half of the writer-routed bulk row ops — `deleteRows`,
 * `clearTable`, `patchRows`.
 *
 * A bulk op is bounded on BOTH sides: the shard writes at most one page of rows
 * per call and reports `hasMore`, and the caller loops that single round-trip
 * (never per-row) up to `maxBatches` times. This is the loop.
 *
 * It lives in `shared/` rather than inside the studio hook it serves because the
 * defect it exists to prevent lives in the SEAM between the two halves, and a
 * seam is only testable from both sides. Studio's data browser drives it against
 * a live worker; `@lunora/do`'s tests drive this exact function against a real
 * `ShardDO`, so the client's request shape is checked against the server that
 * actually answers it rather than against a hand-written mock of one. Mocks on
 * both sides had independently "corrected" a cursor bug into invisibility.
 *
 * Zero-dependency and framework-free on purpose (see CLAUDE.md `shared/` rules):
 * the transport arrives as a `query` callback, so React state, the admin client
 * and the error banners all stay in the caller.
 */

/** What every bulk row op answers with. One shape for all three — the verb lives in the audit record, not the wire. */
export interface BulkRowOpResponse {
    /** Rows this call wrote. */
    count: number;
    /**
     * Keyset cursor to resume from. The shard returns one ONLY when the call
     * itself sent one: the last id of an unordered scan is an arbitrary point in
     * id space, and resuming from it silently skips every row sorting below it.
     */
    cursor?: string;
    /** `true` when matching rows remain beyond this batch. */
    hasMore: boolean;
}

/** Why {@link drainBulkOp} stopped. `"cap-hit"` means matching rows may still remain — the loop just stopped asking. */
export type BulkDrainOutcome = "cap-hit" | "completed";

export interface BulkDrainOptions {
    /** The op's arguments, minus the cursor — this function owns that. */
    args: Record<string, unknown>;

    /**
     * Hard ceiling on round-trips, so a drain can never run unbounded. Each call
     * writes up to the server's own per-call cap.
     */
    maxBatches: number;

    /**
     * Where a RESUMABLE op opens its keyset scan: `""` for a fresh drain (it sorts
     * below every real id), or the cursor a previous capped run parked.
     *
     * `undefined` means the op does not resume, and is not merely "start at the
     * beginning" — its presence is what puts the shard's scan into ordered mode.
     * A delete does not need it (its own writes remove rows from the predicate)
     * and ordering its scan would cost the shard a sequential table scan.
     */
    openCursor?: string;

    /** Issue one round-trip. The caller supplies transport, auth and shard routing. */
    query: (args: Record<string, unknown>) => Promise<BulkRowOpResponse>;
}

export interface BulkDrainResult {
    /**
     * Where the drain stopped, when it was resumable and did not finish — park
     * this and reopen with it so "run it again" resumes instead of rescanning.
     * A patch that leaves rows matching the predicate would otherwise rewrite the
     * same first `maxBatches` pages forever and never reach the tail.
     */
    cursor?: string;
    outcome: BulkDrainOutcome;
    /**
     * Rows written across the batches that RETURNED. Only produced on the success
     * path — a throw mid-drain never returns a result at all, so a caller that
     * needs a partial count on the failure path accumulates it in its own `query`
     * (where a batch's rows are on disk the moment the call resolves).
     */
    written: number;
}

/**
 * Drain a bulk row op, looping while the shard reports `hasMore`.
 *
 * The cursor is owned here and never travels in `args`. It used to be seeded by
 * the caller putting `after: ""` into the args bag, which this loop's own
 * `{ ...args, after }` then overwrote with `undefined` on the first batch — so
 * the opening scan was unordered, and the arbitrary id it returned was used by
 * the next batch as a keyset boundary, silently skipping every matching row
 * below it. One owner, so the two cannot disagree.
 *
 * Throws whatever `query` throws. No result is produced on that path, so a caller
 * that wants to report how much of a destructive op already landed counts inside
 * its own `query` rather than waiting for `written`.
 */
export const drainBulkOp = async (options: BulkDrainOptions): Promise<BulkDrainResult> => {
    const { args, maxBatches, openCursor, query } = options;

    let after = openCursor;
    let written = 0;
    let outcome: BulkDrainOutcome = "cap-hit";

    for (let batch = 0; batch < maxBatches; batch += 1) {
        // eslint-disable-next-line no-await-in-loop -- batches are inherently sequential: each call reflects the prior batch's writes
        const result = await query({ ...args, after });

        written += result.count;
        after = result.cursor;

        if (!result.hasMore) {
            outcome = "completed";
            break;
        }
    }

    // A cap-hit keeps its place so an identical re-run resumes; a clean finish
    // reports none so a later run starts from the top.
    return { cursor: outcome === "cap-hit" ? after : undefined, outcome, written };
};
