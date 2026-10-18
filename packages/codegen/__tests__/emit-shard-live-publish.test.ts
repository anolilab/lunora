import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * `ctx.live.publish` on the ACTION ctx. A scheduled job runs as an action inside
 * its shard, so the shard wires the publish in-process. The wiring is action-only
 * (queries and mutations never publish) and declared-only (an app without a
 * `defineLiveStream`, or one whose target rejected it, gets no `ctx.live`).
 *
 * Like the other shard-emitter suites this pins the emitted STRING; the base-class
 * call is compiled by `emitted-shard-contract.ts`.
 */
const shard = (liveStreams?: boolean): string => emitShard({ liveStreams, schema: { tables: [], vectorIndexes: [] } });

describe("emitShard — ctx.live.publish on the action ctx", () => {
    it("wires publish to the shard's in-process live path when the app declares a live stream", () => {
        expect.assertions(3);

        const emitted = shard(true);

        expect(emitted).toContain("const live = {");
        expect(emitted).toContain("await this.publishLiveFromAction(ref.topic, payload, { ...publishOptions, stream: ref.__lunoraLive });");
        // Attached only inside the `isAction` block, so a query/mutation ctx never carries it.
        expect(emitted).toContain("ctx.live = live;");
    });

    it("emits nothing for live streams when the app declares none or the target rejected them", () => {
        expect.assertions(2);

        const emitted = shard(false);

        expect(emitted).not.toContain("publishLiveFromAction(ref.topic");
        expect(emitted).not.toContain("ctx.live = live;");
    });

    it("strips ctx.live from a composed query's view, the same way it strips other action-only helpers", () => {
        expect.assertions(1);

        expect(shard(true)).toContain("delete descriptors.live;");
    });
});
