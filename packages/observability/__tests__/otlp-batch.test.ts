import { describe, expect, it } from "vitest";

import { createSignalBatcher } from "../../../shared/otlp-batch";

/**
 * `shared/otlp-batch.ts` is bundler-inlined source rather than a package, so it
 * has no test package of its own; it lives here because this is the telemetry
 * package whose sinks buffer through it.
 */
describe("createSignalBatcher", () => {
    it("exports every item and drops none — the size bound is a backstop, not a routine path", async () => {
        expect.assertions(2);

        const exported: number[][] = [];
        const batcher = createSignalBatcher<number>({
            export: (items) => {
                exported.push([...items]);
            },
            maxItems: 2,
        });

        for (let index = 0; index < 7; index += 1) {
            batcher.add(index);
        }

        await batcher.flush();

        // `add` drains at exactly `maxItems`, and `drain` empties the buffer
        // synchronously before it awaits the export — so the drop-oldest bound
        // below it never trips, and no signal is silently discarded. Asserting
        // the full sequence is what keeps that true: a change that empties the
        // buffer LATER (after an await, behind an in-flight guard) starts losing
        // telemetry with nothing to say so.
        expect(exported.flat()).toStrictEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(batcher.size).toBe(0);
    });

    it("still loses nothing when the export never settles and the window stays open", async () => {
        expect.assertions(1);

        const exported: number[][] = [];
        // An export that never settles holds the batch window open; combined
        // with a maxItems of 1 (so every `add` drains) this is the closest a
        // caller can get to overflowing the buffer.
        const batcher = createSignalBatcher<number>({
            export: async (items) => {
                exported.push([...items]);

                return new Promise<void>(() => {});
            },
            maxItems: 1,
        });

        for (let index = 0; index < 5; index += 1) {
            batcher.add(index);
        }

        expect(exported.flat()).toStrictEqual([0, 1, 2, 3, 4]);
    });
});
