/**
 * The activity feed's view model.
 *
 * The feed is a live query, so these run on every push to the tenant's shard —
 * which is the argument for them being pure functions over the rows rather than
 * a controller holding derived state. There is nothing to invalidate.
 */
import { dayKey, relativeTime } from "./format";
import type { ActivityRow } from "./types";

/** One rendered feed entry. */
interface ActivityEntry {
    actorId: string;
    id: string;
    /** Human sentence — "created the project Website". */
    sentence: string;
    timestamp: number;
    /** "4m ago", resolved against the clock the caller passes. */
    when: string;
}

/** A day's worth of entries, newest day first. */
interface ActivityGroup {
    /** `YYYY-MM-DD`. */
    day: string;
    entries: ReadonlyArray<ActivityEntry>;
}

/**
 * Verb phrases for the actions the kit itself records. An action the app adds
 * later falls through to a readable default rather than rendering a raw
 * `project.created` at the user — a feed is worth less than nothing when it
 * shows identifiers.
 */
const SEPARATORS = /[_-]+/gu;

const PHRASES: Record<string, string> = {
    "member.invited": "invited a member",
    "member.joined": "joined the organization",
    "member.removed": "removed a member",
    "project.archived": "archived the project",
    "project.created": "created the project",
    "subscription.changed": "changed the subscription",
};

/** `project.created` → "created the project"; `thing.did` → "did the thing". */
const describeAction = (action: string): string => {
    const phrase = PHRASES[action];

    if (phrase) {
        return phrase;
    }

    const [subject, verb] = action.split(".");

    return verb && subject ? `${verb.replaceAll(SEPARATORS, " ")} the ${subject.replaceAll(SEPARATORS, " ")}` : action;
};

/** The entry's sentence, with the subject's name when the row carried one. */
const describeActivity = (row: ActivityRow): string => {
    const name = typeof row.meta?.name === "string" ? row.meta.name : undefined;
    const phrase = describeAction(row.action);

    return name ? `${phrase} ${name}` : phrase;
};

/**
 * Group a feed into days, newest first, preserving the server's ordering within
 * each day. The server already returns `createdAt` descending, so this does not
 * re-sort: doing so would quietly paper over a query that stopped being ordered.
 */
const groupActivityByDay = (rows: ReadonlyArray<ActivityRow>, now: number): ReadonlyArray<ActivityGroup> => {
    const groups: ActivityGroup[] = [];
    let current: { day: string; entries: ActivityEntry[] } | undefined;

    for (const row of rows) {
        const day = dayKey(row.createdAt);

        if (current?.day !== day) {
            current = { day, entries: [] };
            groups.push(current);
        }

        current.entries.push({
            actorId: row.actorId,
            id: row._id,
            sentence: describeActivity(row),
            timestamp: row.createdAt,
            when: relativeTime(row.createdAt, now),
        });
    }

    return groups;
};

export type { ActivityEntry, ActivityGroup };
export { describeAction, describeActivity, groupActivityByDay };
