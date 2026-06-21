import type { FunctionReference } from "@lunora/client";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { MutationClient } from "../src/create-mutation";
import { createMutationForClient } from "../src/create-mutation";

const sendRef = { __lunoraRef: "messages:send" } as FunctionReference;

describe(createMutationForClient, () => {
    it("resolves with the server result and exposes it on data()", async () => {
        await createRoot(async (dispose) => {
            const client: MutationClient<typeof sendRef> = {
                mutation: (_function_, args) => Promise.resolve({ echoed: args }),
            };

            const handle = createMutationForClient(client, sendRef);

            expect(handle.data()).toBeUndefined();
            expect(handle.pending()).toBe(false);

            const result = await handle.mutate({ text: "hi" });

            expect(result).toStrictEqual({ echoed: { text: "hi" } });
            expect(handle.data()).toStrictEqual({ echoed: { text: "hi" } });
            expect(handle.error()).toBeUndefined();
            expect(handle.pending()).toBe(false);

            dispose();
        });
    });

    it("flips pending true while in flight and back to false once settled", async () => {
        await createRoot(async (dispose) => {
            let release!: (value: unknown) => void;
            const gate = new Promise((resolve) => {
                release = resolve;
            });

            const client: MutationClient<typeof sendRef> = {
                mutation: () => gate,
            };

            const handle = createMutationForClient(client, sendRef);
            const pending = handle.mutate({ text: "x" });

            expect(handle.pending()).toBe(true);

            release({ ok: true });
            await pending;

            expect(handle.pending()).toBe(false);

            dispose();
        });
    });

    it("captures the error and rejects, then reset() clears it", async () => {
        await createRoot(async (dispose) => {
            const boom = new Error("nope");
            const client: MutationClient<typeof sendRef> = {
                mutation: () => Promise.reject(boom),
            };

            const handle = createMutationForClient(client, sendRef);

            await expect(handle.mutate({ text: "x" })).rejects.toThrow("nope");
            expect(handle.error()).toBe(boom);
            expect(handle.pending()).toBe(false);

            handle.reset();

            expect(handle.error()).toBeUndefined();

            dispose();
        });
    });

    it("forwards the optimistic call options straight to client.mutation", async () => {
        await createRoot(async (dispose) => {
            let received: unknown;
            const client: MutationClient<typeof sendRef> = {
                mutation: (_function_, _args, options) => {
                    received = options;

                    return Promise.resolve(null);
                },
            };

            const handle = createMutationForClient(client, sendRef);
            const optimisticUpdate = (): void => {};

            await handle.mutate({ text: "x" }, { optimisticUpdate, shardKey: "channel:demo" });

            expect(received).toStrictEqual({ optimisticUpdate, shardKey: "channel:demo" });

            dispose();
        });
    });
});
