import { describe, expect, it } from "vitest";

import { buildBaseWorkerOptions } from "../src/emit/app-worker-options";

/**
 * The generated push-consumer forwards the runtime's shard-backed publisher as
 * `ctx.live` only for an app whose target serves live streams. Without that gate a
 * target with no SSE route (celld, node) would hand a queue handler a `ctx.live`
 * that publishes to nothing.
 */
type WorkerOptionsInput = Parameters<typeof buildBaseWorkerOptions>[0];

const emit = (liveStreams: boolean): string =>
    buildBaseWorkerOptions({
        hasQueue: true,
        jurisdiction: undefined,
        liveStreams,
        wantsArchitecture: false,
        wantsOpenApi: false,
        wantsOpenRpc: false,
    } as unknown as WorkerOptionsInput).join("\n");

describe("generated worker options — queue consumer ctx.live", () => {
    it("takes the runtime publisher as the fifth argument and forwards it to the dispatcher when live streams are served", () => {
        expect.assertions(2);

        const emitted = emit(true);

        expect(emitted).toContain('queueLive: Parameters<typeof dispatchQueueBatch>[2]["live"]');
        expect(emitted).toContain("live: queueLive,");
    });

    it("leaves the consumer without ctx.live when the app declares no served live stream", () => {
        expect.assertions(2);

        const emitted = emit(false);

        expect(emitted).not.toContain("queueLive");
        expect(emitted).not.toContain("live: queueLive");
    });
});
