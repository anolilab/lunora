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
 * The FIELD half of a recorded profile — everything after the analyzer's `:`,
 * minus any backend layout suffix a backend appended with `/`.
 *
 * Read back rather than re-derived because the two halves of a profile mean
 * different things to a REBUILD in progress. An analyzer change leaves every
 * stored row holding the right column's text under older rules — stale, but an
 * answer about the column that was asked for — so the read path is allowed to
 * keep serving it while the re-walk runs. A FIELD change does not: every stored
 * row holds the text of the column the index was just pointed AWAY from, so
 * serving it is a confidently wrong answer about a different column, for the
 * whole walk. Told apart here so both planes decide it the same way.
 *
 * Neither an analyzer profile (`<lang>-v<n>`) nor a field (a bare SQL
 * identifier) can contain `:` or `/`, so the split is unambiguous.
 */
export const searchIndexField = (profile: string): string => {
    const afterAnalyzer = profile.slice(profile.indexOf(":") + 1);
    const layoutAt = afterAnalyzer.lastIndexOf("/");

    return layoutAt === -1 ? afterAnalyzer : afterAnalyzer.slice(0, layoutAt);
};

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

    /**
     * Restart the walk at the top of the table: the companion's rows were built
     * under a profile the query side no longer uses.
     *
     * It does NOT mean "empty the companion", and no engine does — emptying took
     * a complete index down to nothing and refilled it a page per request. Every
     * layout writes a document DELETE-then-INSERT, so the re-walk converges on
     * the new profile in place while each row keeps serving the old one until
     * its turn. `cursor` is `undefined` whenever this is set; the flag adds only
     * "there was something in there", which is what separates a rebuild from a
     * never-started index.
     */
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

/**
 * May a companion's `covered` flag — "this holds a row for every document" —
 * survive into a rebuild under `profile`, given the `recorded` profile the
 * stored rows were built with?
 *
 * The flag is what lets a REBUILDING companion keep serving while a NEW one
 * refuses, and refusing is expensive: an analyzer-version bump rebuilds every
 * index in the fleet at once, and taking search offline for the length of each
 * re-walk — one page per request-driven pass — is a worse answer than serving
 * rows analyzed under the previous rules. Nothing is emptied (see
 * {@link SearchBackfillPass.wipe}), so those rows are all still there.
 *
 * What that justification rests on is that the stored rows are an answer about
 * THE COLUMN THAT WAS ASKED FOR, merely under older rules. Two cases break it:
 *
 * THE FIELD MOVED. Every stored row now holds the text of the column the index
 * was pointed away from, so serving it answers a search over one column with
 * matches from another — confidently, for the whole re-walk.
 *
 * NOTHING WAS RECORDED AT ALL. A row written before profile tracking existed
 * carries no profile, so which column analyzed those rows is simply unknown, and
 * a field change in the very deploy that added tracking is indistinguishable
 * from no change at all. Unverifiable is treated as unverified.
 *
 * **Operational cost of that second case, which is paid once per deployment
 * that predates profile tracking:** its progress row reads `{done, covered}`
 * with no profile, so the first backfill page after the upgrade drops `covered`
 * and every search on that index answers 503 `SEARCH_INDEX_BUILDING` until the
 * re-walk completes — where the build before it kept serving. The window is
 * bounded by one walk, it is loud rather than silent, and the error names the
 * `backfillSearch` admin op that closes it in a single call. That is the trade:
 * a visible, one-time, operator-closable refusal instead of matches over a
 * column nothing can confirm.
 *
 * Shared for the same reason as {@link planSearchBackfillPass}: one policy, and
 * the two engines that read it disagreed the last time each owned a copy.
 * `recorded` is `unknown` because the engines' drivers disagree about how a NULL
 * text column comes back, and that disagreement is exactly how they would start
 * answering this differently.
 */
export const searchCoverageSurvives = (recorded: unknown, profile: string): boolean =>
    typeof recorded === "string" && searchIndexField(recorded) === searchIndexField(profile);
