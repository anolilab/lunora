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

import { createSearchAnalyzer } from "./analyzer";

/**
 * The profile recorded alongside a companion's backfill progress: everything
 * about the index that changes what the companion *stores*.
 *
 * Produced here rather than in either engine because it is the input to
 * {@link planSearchBackfillPass} below — the two have to agree on what counts
 * as a rebuild, and a producer sitting beside the consumer is what stops one
 * engine detecting a change the other misses.
 *
 * Two facts today. The **analyzer** profile, since analysis is baked into
 * stored tokens. And the indexed **field**, since re-pointing an index at
 * another column leaves every stored row holding the text of the column you
 * abandoned — analysis alone left that undetected, so searching the column you
 * just declared returned nothing while the old one kept matching, under an
 * index that reported itself complete.
 *
 * `filterFields` is deliberately NOT here. It never reaches a companion: no
 * layout stores it, and it is read only when a staged query validates which
 * columns `.eq()` may narrow by. Including it would rebuild every index on the
 * table for a change that cannot have invalidated a single stored row.
 *
 * A backend that also chooses a physical *layout* appends its own identity to
 * this string — the shape of the companion is a fourth fact, but only where
 * there is more than one shape.
 */
export const searchIndexProfile = (index: { field: string; language?: string }): string => `${createSearchAnalyzer(index.language).profile}:${index.field}`;

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
