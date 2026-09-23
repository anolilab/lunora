/**
 * Who is looking at this right now.
 *
 * Presence rows are per-TAB — one row per open connection, which is what makes
 * a heartbeat cheap and a disconnect detectable. A roster is per-PERSON, so the
 * whole job here is collapsing the first into the second without losing the
 * "still here" signal: two tabs are one person, and that person is as present as
 * their most recent heartbeat.
 *
 * Pure, like everything else in this directory. The TTL that decides whether a
 * row counts at all is applied server-side by the presence item's `listPresent`,
 * so anything that arrives here is by definition live.
 */

/** A row of the presence item's `listPresent`. */
interface PresenceMemberLike {
    data?: Record<string, unknown>;
    lastSeen: number;
    sessionId: string;
    userId?: string;
}

interface RosterEntry {
    /** How many tabs this person has open. Worth showing nowhere; worth knowing when debugging. */
    connections: number;
    /** `true` for the viewer's own entry, so a view can label it "you". */
    isSelf: boolean;
    /** Stable key — the user id when known, else the session id. */
    key: string;
    lastSeen: number;
    /** Display name from the awareness blob, falling back to the key. */
    name: string;
}

interface Roster {
    /** Everyone present, self first, then most recently active. */
    entries: ReadonlyArray<RosterEntry>;
    /** People beyond the cap. `0` when everyone fits. */
    overflow: number;
    /** Distinct people, ignoring the cap. */
    total: number;
}

const displayName = (member: PresenceMemberLike, key: string): string => {
    const name = member.data?.["name"];

    return typeof name === "string" && name.trim() !== "" ? name : key;
};

/**
 * Collapse presence rows into a roster.
 *
 * Self sorts first because a viewer looking for themselves and not finding
 * themselves concludes the feature is broken; after that, most recently active,
 * which is the only ordering that stays stable while people come and go.
 * `cap` bounds how many entries come back; the rest become `overflow`, because
 * an avatar row that grows without bound stops being readable at about eight.
 */
const presenceRoster = (members: ReadonlyArray<PresenceMemberLike>, currentUserId: string | undefined, cap = 8): Roster => {
    const byPerson = new Map<string, RosterEntry>();

    for (const member of members) {
        // An anonymous viewer is keyed by tab: there is nothing else to collapse
        // them by, and merging two strangers into one entry is worse than
        // showing two.
        const key = member.userId ?? member.sessionId;
        const existing = byPerson.get(key);

        if (existing) {
            existing.connections += 1;
            existing.lastSeen = Math.max(existing.lastSeen, member.lastSeen);

            continue;
        }

        byPerson.set(key, {
            connections: 1,
            isSelf: member.userId !== undefined && member.userId === currentUserId,
            key,
            lastSeen: member.lastSeen,
            name: displayName(member, key),
        });
    }

    const sorted = [...byPerson.values()].toSorted((a, b) => {
        if (a.isSelf !== b.isSelf) {
            return a.isSelf ? -1 : 1;
        }

        return b.lastSeen - a.lastSeen;
    });

    return { entries: sorted.slice(0, cap), overflow: Math.max(0, sorted.length - cap), total: sorted.length };
};

/** The sentence a roster is actually read as — "3 other people are here". */
const presenceSummary = (roster: Roster): string => {
    const others = roster.entries.some((entry) => entry.isSelf) ? roster.total - 1 : roster.total;

    if (roster.total === 0) {
        return "No one else is here";
    }

    if (others === 0) {
        return "Only you are here";
    }

    return others === 1 ? "1 other person is here" : `${others.toString()} other people are here`;
};

export type { PresenceMemberLike, Roster, RosterEntry };
export { presenceRoster, presenceSummary };
