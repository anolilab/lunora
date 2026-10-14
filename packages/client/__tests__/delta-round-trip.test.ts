import { subscriptionFrames } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { MutationDelta } from "../src/delta-merge";
import { applyDelta } from "../src/delta-merge";

/** The fixed frame-envelope inputs every case shares. */
const base = { cursorSuffix: "", subId: "sub-1", table: "messages" };

const typesOf = (frames: string[]): string[] => frames.map((frame) => (JSON.parse(frame) as { type: string }).type);

/**
 * The property the whole delta path rests on: whichever frames the server picks,
 * a client that applies them ends up holding EXACTLY the value the server would
 * otherwise have sent as a snapshot.
 *
 * Tested against the two halves together, not each alone, because they can each
 * be self-consistent and still disagree — and when they do the server advances
 * its diff baseline to the value it BELIEVES the client now holds, so the
 * divergence persists silently until a reconnect. `applyDelta` is imported from
 * `@lunora/client` on purpose: this asserts against the real merge rather than a
 * re-implementation that could drift with it.
 */
describe("subscriptionFrames — server/client round-trip", () => {
    /** Apply the chosen frames the way a real client does, and return the value it lands on. */
    const clientValueAfter = (previous: unknown, next: unknown, pageDeltas?: boolean): unknown => {
        const frames = subscriptionFrames({
            ...base,
            nextResult: next,
            pageDeltas,
            previousJson: JSON.stringify(previous),
            snapshotJson: JSON.stringify(next),
        });

        let value = previous;

        for (const frame of frames) {
            const parsed = JSON.parse(frame) as { data?: unknown; delta?: MutationDelta; type: string };

            // A `data` frame replaces wholesale; a `delta` merges in place.
            value = parsed.type === "data" ? parsed.data : (applyDelta(value, parsed.delta as MutationDelta) ?? value);
        }

        return value;
    };

    const roundTrips = (previous: unknown, next: unknown, pageDeltas?: boolean): void => {
        expect(clientValueAfter(previous, next, pageDeltas)).toStrictEqual(next);
    };

    const list = (count: number): Record<string, unknown>[] =>
        Array.from({ length: count }, (_, index) => {
            return { _creationTime: 1000 + index, _id: `r${String(index)}` };
        });

    const asPage = (rows: Record<string, unknown>[]): Record<string, unknown> => {
        return { continueCursor: "c", isDone: false, page: rows };
    };

    it("round-trips an update, an insert, and a delete on a bare list", () => {
        expect.assertions(3);

        const previous = list(20);

        roundTrips(previous, [...previous.slice(0, 19), { ...previous[19], edited: true }]);
        roundTrips(previous, [...previous, { _creationTime: 9999, _id: "new" }]);
        roundTrips(previous, previous.slice(1));
    });

    it("round-trips the same three changes on a paginated result", () => {
        expect.assertions(3);

        const previous = asPage(list(20));

        roundTrips(previous, asPage([...list(20).slice(0, 19), { ...list(20)[19], edited: true }]), true);
        roundTrips(previous, asPage([...list(20), { _creationTime: 9999, _id: "new" }]), true);
        roundTrips(previous, asPage(list(20).slice(1)), true);
    });

    it("round-trips an insert into a list ordered by something other than _creationTime", () => {
        expect.assertions(1);

        // The case that made this check necessary. `.withIndex(...).paginate()`
        // orders by the index fields, so the server's position for a new row need
        // not be where the client's `_creationTime` heuristic would splice it.
        // Here the newcomer sorts mid-list by `priority` but is the NEWEST row, so
        // the heuristic alone would put it at the front of this newest-first list
        // and the two sides would silently disagree from then on.
        const previous = [
            { _creationTime: 5000, _id: "a", priority: 10 },
            { _creationTime: 1000, _id: "b", priority: 20 },
            { _creationTime: 2000, _id: "c", priority: 30 },
        ];

        roundTrips(previous, [previous[0]!, { _creationTime: 9000, _id: "n", priority: 15 }, previous[1]!, previous[2]!]);
    });

    it("still sends a newest-first feed's insert as a delta", () => {
        expect.assertions(2);

        // The case the heuristic exists FOR: a newest-first feed where the new row
        // genuinely belongs at the front. This must stay on the delta path — the
        // order check must not have turned every insert into a snapshot.
        const previous = Array.from({ length: 20 }, (_, index) => {
            return { _creationTime: 9000 - index, _id: `r${String(index)}` };
        });
        const next = [{ _creationTime: 9999, _id: "new" }, ...previous];

        expect(
            typesOf(subscriptionFrames({ ...base, nextResult: next, previousJson: JSON.stringify(previous), snapshotJson: JSON.stringify(next) })),
        ).toStrictEqual(["delta"]);

        roundTrips(previous, next);
    });
});
