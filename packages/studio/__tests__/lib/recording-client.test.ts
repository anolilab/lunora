import { beforeEach, describe, expect, it } from "vitest";

import { operationLog } from "../../src/lib/operation-log";
import { operationSeqOf, withOperationRecording } from "../../src/lib/recording-client";

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

    type Dispatch = (reference: unknown, args?: unknown, options?: unknown) => Promise<unknown>;

    const wrap = (methods: Record<string, Dispatch>): Record<string, Dispatch> =>
        withOperationRecording(methods as never) as unknown as Record<string, Dispatch>;

    it("prefers the options' shard over the args' for a streamed call", async () => {
        expect.assertions(1);

        await wrap({ streamRpc: () => Promise.resolve({}) }).streamRpc?.(REFERENCE, { shardKey: "from-args" }, { shardKey: "from-options" });

        expect(operationLog.getSnapshot().map((entry) => entry.shardKey)).toStrictEqual(["from-options"]);
    });

    it("does not read the shard out of the args for a plain query", async () => {
        expect.assertions(1);

        await wrap({ query: () => Promise.resolve({}) }).query?.(REFERENCE, { shardKey: "from-args" });

        expect(operationLog.getSnapshot().map((entry) => entry.shardKey)).toStrictEqual([""]);
    });

    it("lands a streamed call with no shard anywhere on the root shard", async () => {
        expect.assertions(1);

        await wrap({ streamRpc: () => Promise.resolve({}) }).streamRpc?.(REFERENCE, { shardKey: 7 });

        expect(operationLog.getSnapshot().map((entry) => entry.shardKey)).toStrictEqual([""]);
    });

    it("passes a path that is not a Studio admin op straight through, unrecorded", async () => {
        expect.assertions(2);

        const result = await wrap({ query: () => Promise.resolve("user-data") }).query?.({ __lunoraRef: "messages:list" }, {});

        expect(result).toBe("user-data");
        expect(operationLog.getSnapshot()).toHaveLength(0);
    });

    it("tags a rejected streamed call with its tape entry and rethrows the original error", async () => {
        expect.assertions(3);

        const failure = new Error("stream cut");
        const client = wrap({ streamRpc: () => Promise.reject(failure) });

        await expect(client.streamRpc?.(REFERENCE, {})).rejects.toBe(failure);

        expect(operationLog.getSnapshot()[0]?.error).toBe("stream cut");
        expect(operationSeqOf(failure)).toBe(operationLog.getSnapshot()[0]?.seq);
    });

    it("rethrows a frozen rejection unchanged rather than failing to tag it", async () => {
        expect.assertions(2);

        const failure = Object.freeze(new Error("frozen"));

        await expect(wrap({ query: () => Promise.reject(failure) }).query?.(REFERENCE, {})).rejects.toBe(failure);

        expect(operationSeqOf(failure)).toBeUndefined();
    });

    it("records a non-Error rejection by its string form", async () => {
        expect.assertions(1);

        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test: a non-Error rejection
        await wrap({ mutation: () => Promise.reject("plain string") })
            .mutation?.(REFERENCE, {})
            .catch(() => undefined);

        expect(operationLog.getSnapshot()[0]?.error).toBe("plain string");
    });
});
