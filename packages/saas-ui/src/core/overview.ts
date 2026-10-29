/**
 * The dashboard's stat tiles, derived from the one `api.saas.overview`
 * subscription rather than from counting queries.
 *
 * That is the whole point of deriving them here: a separate `countProjects`
 * query would be a second subscription over the same shard, pushed on the same
 * writes, to compute a number the rows in hand already answer.
 */
import { projectCounts } from "./projects";
import type { OverviewPayload } from "./types";

interface StatTile {
    /** Stable key for list rendering and tests. */
    id: string;
    label: string;
    /** Optional one-line context under the value. */
    note?: string;
    value: number;
}

const DAY = 86_400_000;

/**
 * Rows `api.saas.overview` returns of the activity feed — restated from the
 * `saas` item's `SAAS_ACTIVITY_PAGE`, as `types.ts` restates the row shapes: this
 * package cannot import the item. The two windows below are counted over those
 * rows only, so past this many events the counts stop being exact.
 */
const ACTIVITY_PAGE = 50;

const atLeastNote = (window: string): string => `at least — last ${window}, latest ${ACTIVITY_PAGE.toString()} events counted`;

/**
 * Four tiles: active projects, archived, activity in the last 24h, and the
 * number of distinct people who did something this week. The last one is the
 * only tile that says anything about the *team*, which is why it earns a place
 * over a second project count.
 */
const deriveOverviewStats = (payload: OverviewPayload, now: number): ReadonlyArray<StatTile> => {
    const counts = projectCounts(payload.projects);
    const dayCutoff = now - DAY;
    const weekCutoff = now - 7 * DAY;

    // One walk of the feed rather than three: both tiles below are windows over
    // the same rows, and the feed is the largest thing on the page.
    let today = 0;
    const weekActors = new Set<string>();

    // The feed is newest-first and capped, so a window the page never leaves is
    // cut short: its tile is a lower bound, not a count.
    const oldest = payload.activity.at(-1)?.createdAt;
    const truncatedWithin = (cutoff: number): boolean => payload.activity.length >= ACTIVITY_PAGE && oldest !== undefined && oldest > cutoff;

    for (const row of payload.activity) {
        if (row.createdAt > dayCutoff) {
            today += 1;
        }

        if (row.createdAt > weekCutoff) {
            weekActors.add(row.actorId);
        }
    }

    return [
        { id: "projects", label: "Active projects", value: counts.active },
        { id: "archived", label: "Archived", value: counts.archived },
        { id: "activity", label: "Events today", note: truncatedWithin(dayCutoff) ? atLeastNote("24 hours") : "last 24 hours", value: today },
        { id: "actors", label: "People active", note: truncatedWithin(weekCutoff) ? atLeastNote("7 days") : "last 7 days", value: weekActors.size },
    ];
};

/**
 * Whether the dashboard should render its empty state instead of the tiles. A
 * brand-new tenant has no projects and exactly no activity; showing it four
 * zeroes is how a product tells someone they are lost.
 */
const isFirstRun = (payload: OverviewPayload): boolean => payload.projects.length === 0 && payload.activity.length === 0;

export type { StatTile };
export { deriveOverviewStats, isFirstRun };
