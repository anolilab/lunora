/**
 * How far a search companion's backfill has progressed, and what the next pass
 * should do about it.
 *
 * Neither stored analysis nor query policy, which is why it is its own module
 * rather than a third responsibility bolted onto one of them: it is *progress*,
 * the one piece of search state that is written as the index is built rather
 * than decided when it is read.
 *
 * The policy below is shared because when each engine owned a copy they
 * immediately disagreed about exactly the two cases that matter — whether a row
 * with no recorded profile may be resumed (it may not; nothing says what
 * analyzed it) and whether a never-started index is worth wiping (it is not;
 * there is nothing in it).
 */

/**
 * How far a companion's backfill has progressed, and under which analysis.
 * Declared here rather than beside either engine's state table: both record the
 * same three facts, and the decisions made from them are the shared policy
 * below.
 */
export interface SearchBackfillState {
    /** Last `id` indexed, or `undefined` when no page has run yet. */
    cursor: string | undefined;
    /** True once a page came back short — the table is fully indexed. */
    done: boolean;
    /** Analyzer profile the stored rows were built with; `undefined` predates profile tracking. */
    profile: string | undefined;
}

/** What a backfill pass should do, given where the last one got to. */
export interface SearchBackfillPass {
    /** Resume past this id; `undefined` starts from the beginning of the table. */
    cursor: string | undefined;
    /** Nothing left to index. */
    finished: boolean;
    /** Discard the companion's contents before walking — its rows were analyzed by rules the query side no longer uses. */
    wipe: boolean;
}

/**
 * Decide a backfill pass from recorded progress. Pure, and shared, because this
 * is a *policy* rather than an engine detail — and when each backend owned a
 * copy they immediately disagreed about the two cases that matter: whether a
 * row with no recorded profile may be resumed (it may not — nothing says what
 * analyzed it), and whether a never-started index is worth wiping (it is not,
 * there is nothing in it).
 */
export const planSearchBackfillPass = (state: SearchBackfillState, profile: string): SearchBackfillPass => {
    if (state.profile !== profile) {
        return { cursor: undefined, finished: false, wipe: state.cursor !== undefined || state.done };
    }

    return { cursor: state.cursor, finished: state.done, wipe: false };
};
