import type { FunctionReference } from "@lunora/client";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { ActionClient } from "../src/create-action";
import { createActionForClient } from "../src/create-action";

const runRef = { __lunoraRef: "commands:run" } as FunctionReference;

describe(createActionForClient, () => {
    it("resolves with the server result and exposes it on data()", async () => {
        await createRoot(async (dispose) => {
            const client: ActionClient<typeof runRef> = {
                action: (_function_, args) => Promise.resolve({ echoed: args }),
            };

            const handle = createActionForClient(client, runRef);

            expect(handle.data()).toBeUndefined();
            expect(handle.pending()).toBe(false);

            const result = await handle.call({ command: "lunora" });

            expect(result).toStrictEqual({ echoed: { command: "lunora" } });
            expect(handle.data()).toStrictEqual({ echoed: { command: "lunora" } });
            expect(handle.pending()).toBe(false);

            dispose();
        });
    });

    it("forwards per-call options to the client", async () => {
        await createRoot(async (dispose) => {
            const calls: { options?: { shardKey?: string } }[] = [];
            const client: ActionClient<typeof runRef> = {
                action: (_function_, _args, options) => {
                    calls.push({ options });

                    return Promise.resolve({ code: 0 });
                },
            };

            await createActionForClient(client, runRef).call({ command: "lunora" }, { shardKey: "project-1" });

            expect(calls[0]?.options).toStrictEqual({ shardKey: "project-1" });

            dispose();
        });
    });

    it("records a normalized error, rejects, and clears pending", async () => {
        await createRoot(async (dispose) => {
            const client: ActionClient<typeof runRef> = {
                // Deliberately rejects with a non-Error string, to prove the
                // runner normalizes it before it reaches `error()`.
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
                action: () => Promise.reject("refused"),
            };

            const handle = createActionForClient(client, runRef);

            await expect(handle.call({ command: "bash" })).rejects.toThrow("refused");
            expect(handle.error()).toBeInstanceOf(Error);
            expect(handle.pending()).toBe(false);

            dispose();
        });
    });

    it("keeps pending true until the last of several overlapping calls settles", async () => {
        await createRoot(async (dispose) => {
            const resolvers: ((value: unknown) => void)[] = [];
            const client: ActionClient<typeof runRef> = {
                action: () =>
                    new Promise((resolve) => {
                        resolvers.push(resolve);
                    }),
            };

            const handle = createActionForClient(client, runRef);
            const both = Promise.all([handle.call({ command: "lunora" }), handle.call({ command: "pnpm" })]);

            expect(handle.pending()).toBe(true);

            resolvers[0]?.({ code: 0 });
            await Promise.resolve();

            expect(handle.pending()).toBe(true);

            resolvers[1]?.({ code: 0 });
            await both;

            expect(handle.pending()).toBe(false);

            dispose();
        });
    });
});
