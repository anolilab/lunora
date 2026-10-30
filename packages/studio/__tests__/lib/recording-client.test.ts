import { beforeEach, describe, expect, it } from "vitest";

import { operationLog } from "../../src/lib/operation-log";
import { withOperationRecording } from "../../src/lib/recording-client";

const REFERENCE = { __lunoraRef: "__lunora_admin__:aiChat" };

describe("withOperationRecording", () => {
    beforeEach(() => {
        operationLog.clear();
    });

    it("records a streamed call against the shard named in its args, not the options", async () => {
        expect.assertions(1);

        const client = withOperationRecording({ streamRpc: () => Promise.resolve({}) } as never) as unknown as {
            streamRpc: (reference: unknown, args: unknown, options: unknown) => Promise<unknown>;
        };

        // A streamed call's options hold the frame callback and abort signal; the
        // shard its tools read rides in the args.
        await client.streamRpc(REFERENCE, { shardKey: "channel:demo" }, { onFrame: () => undefined });

        expect(operationLog.getSnapshot().map((entry) => entry.shardKey)).toStrictEqual(["channel:demo"]);
    });
});
