import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { mutate } from "../src/mutate";
import { createFakeClient } from "./fake-client";

const sendRef = { __lunoraRef: "messages:send" } as FunctionReference;

describe(mutate, () => {
    it("calls the client's mutation and resolves with the result", async () => {
        const fake = createFakeClient();
        fake.setMutationResult({ id: "msg_1" });

        const result = await mutate(sendRef, { text: "hi" }, { client: fake.asClient });

        expect(result).toStrictEqual({ id: "msg_1" });
        expect(fake.mutationCalls).toHaveLength(1);
        expect(fake.mutationCalls[0]?.functionPath).toBe("messages:send");
        expect(fake.mutationCalls[0]?.args).toStrictEqual({ text: "hi" });
    });

    it("forwards shardKey and does not leak the client into the call options", async () => {
        const fake = createFakeClient();

        await mutate(sendRef, { text: "hi" }, { client: fake.asClient, shardKey: "channel:demo" });

        expect(fake.mutationCalls[0]?.options).toStrictEqual({ shardKey: "channel:demo" });
    });

    it("rejects when the client's mutation throws", async () => {
        const fake = createFakeClient();
        fake.setMutationThrow(new Error("boom"));

        await expect(mutate(sendRef, { text: "hi" }, { client: fake.asClient })).rejects.toThrow("boom");
    });
});
