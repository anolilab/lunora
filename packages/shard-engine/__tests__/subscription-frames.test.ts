import { describe, expect, it } from "vitest";

import { subscriptionFrames } from "../src/subscription-delivery";

/**
 * `subscriptionFrames` owns two things the rest of the delivery path relies on:
 * the exact `{type:"data"}` / `{type:"delta"}` wire layout, and the choice
 * between them. Both are pinned here — no Durable Object, no socket, no
 * fixture tuned to sit on one side of a threshold. The DO-level tests in
 * `@lunora/do` assert that the chosen frames reach the socket; this file
 * asserts which frames get chosen and what they look like.
 */

const row = (id: string, rest: Record<string, unknown> = {}): Record<string, unknown> => {
    return { _creationTime: 1, _id: id, ...rest };
};

/** The fixed inputs every case shares; each test overrides what it is about. */
const base = { cursorSuffix: "", subId: "sub-1", table: "messages" };

const framesFor = (previous: Record<string, unknown>[] | undefined, next: unknown, extra: Record<string, unknown> = {}): string[] =>
    subscriptionFrames({
        ...base,
        ...extra,
        nextResult: next,
        previousJson: previous === undefined ? undefined : JSON.stringify(previous),
        snapshotJson: JSON.stringify(next),
    });

const typesOf = (frames: string[]): string[] => frames.map((frame) => (JSON.parse(frame) as { type: string }).type);

describe("subscriptionFrames — frame layout", () => {
    it("renders the snapshot with no baseline to diff against", () => {
        expect.assertions(1);

        expect(framesFor(undefined, [row("a")])).toStrictEqual([`{"type":"data","id":"sub-1","data":[{"_creationTime":1,"_id":"a"}]}`]);
    });

    it("renders one delta frame per changed row, deletes before upserts", () => {
        expect.assertions(2);

        // Long enough that a single delta is unambiguously the cheaper encoding.
        const previous = Array.from({ length: 20 }, (_, index) => row(`r${String(index)}`));
        const frames = framesFor(previous, [...previous, row("new")]);

        expect(frames).toHaveLength(1);
        expect(frames[0]).toBe(`{"type":"delta","id":"sub-1","delta":{"key":"new","op":"insert","row":{"_creationTime":1,"_id":"new"},"table":"messages"}}`);
    });

    it("stamps the watermark and cursor suffix on every frame of a multi-delta batch", () => {
        expect.assertions(2);

        // A client's checkpoint gate reads whichever frame it happens to observe,
        // so a batch whose later frames lack the watermark starves it (plan 266
        // finding d). Every frame carries it, not just the last.
        const previous = Array.from({ length: 20 }, (_, index) => row(`r${String(index)}`));
        const next = previous.map((existing, index) => (index < 3 ? row(`r${String(index)}`, { edited: true }) : existing));
        const frames = framesFor(previous, next, { cursorSuffix: `,"cursor":42,"epoch":"e1"`, lastMutationId: 7 });

        expect(frames).toHaveLength(3);
        expect(frames.every((frame) => frame.endsWith(`,"lastMutationId":7,"cursor":42,"epoch":"e1"}`))).toBe(true);
    });
});

describe("subscriptionFrames — delta vs snapshot", () => {
    it("takes the deltas when they are smaller than the snapshot", () => {
        expect.assertions(1);

        const previous = Array.from({ length: 50 }, (_, index) => row(`r${String(index)}`));
        const next = previous.map((existing, index) => (index === 0 ? row("r0", { edited: true }) : existing));

        expect(typesOf(framesFor(previous, next))).toStrictEqual(["delta"]);
    });

    it("takes the snapshot when every row changed, even though the diff is expressible", () => {
        expect.assertions(2);

        // The row-count rule this replaced allowed exactly this: 20 deltas for a
        // 20-row result is "no more deltas than rows". But each frame re-pays the
        // envelope the snapshot pays once, so the deltas are the larger payload.
        const previous = Array.from({ length: 20 }, (_, index) => row(`r${String(index)}`));
        const next = previous.map((existing) => {
            return { ...existing, edited: true };
        });
        const frames = framesFor(previous, next);

        expect(typesOf(frames)).toStrictEqual(["data"]);
        expect(frames).toHaveLength(1);
    });

    it("takes the snapshot for a single delta into a short list of small rows", () => {
        expect.assertions(1);

        // The other direction the row count cannot see: one delta is well under
        // the cap, but its envelope alone outweighs re-sending both rows.
        expect(typesOf(framesFor([row("a")], [row("a"), row("b")]))).toStrictEqual(["data"]);
    });

    it("takes the deltas for the same single change once the rows are fat enough", () => {
        expect.assertions(1);

        // Identical row COUNT to the case above — only the row width differs, which
        // is exactly the input a count-based rule is blind to.
        const wide = (id: string) => row(id, { body: "lorem ipsum dolor sit amet ".repeat(8) });

        expect(typesOf(framesFor([wide("a")], [wide("a"), wide("b")]))).toStrictEqual(["delta"]);
    });

    it("takes the snapshot when the result is not a diffable list", () => {
        expect.assertions(2);

        // The paginated shape `.paginate()` returns: an object wrapping the array,
        // so there is no id-keyed list to diff and every write re-sends the page.
        expect(typesOf(framesFor([row("a")], { continueCursor: null, isDone: true, page: [row("a"), row("b")] }))).toStrictEqual(["data"]);
        // A reordered survivor cannot be expressed as in-place merges either.
        expect(typesOf(framesFor([row("a"), row("b")], [row("b"), row("a")]))).toStrictEqual(["data"]);
    });
});
