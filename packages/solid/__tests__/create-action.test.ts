import type { FunctionReference } from "@lunora/client";
import { createEffect, createRoot } from "solid-js";
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

    // Ref-counted `pending` across overlapping calls lives entirely in
    // `createCallRunner` and is pinned there; what only a Solid test can prove
    // is that the runner's writes land in signals a component actually tracks.
    it("notifies a tracked effect when data and pending change", async () => {
        await createRoot(async (dispose) => {
            const client: ActionClient<typeof runRef> = {
                action: () => Promise.resolve({ code: 0 }),
            };

            const handle = createActionForClient(client, runRef);
            const seen: { data: unknown; pending: boolean }[] = [];

            createEffect(() => {
                seen.push({ data: handle.data(), pending: handle.pending() });
            });

            // Let the initial effect run before the call, so what follows is the
            // notification and not the first tracking pass.
            await Promise.resolve();
            await handle.call({ command: "lunora" });
            await Promise.resolve();

            expect(seen.at(-1)).toStrictEqual({ data: { code: 0 }, pending: false });
            expect(seen.length).toBeGreaterThan(1);

            dispose();
        });
    });

    it("stores a function-valued result instead of invoking it", async () => {
        await createRoot(async (dispose) => {
            const returned = (): string => "not called";
            const client: ActionClient<typeof runRef> = {
                action: () => Promise.resolve(returned),
            };

            // Solid's setter treats a bare function as an updater, so the sink
            // wraps the result in a thunk. Without that, `data()` would hold
            // whatever the server's function returned when Solid called it.
            const handle = createActionForClient(client, runRef);

            await handle.call({ command: "lunora" });

            expect(handle.data()).toBe(returned);

            dispose();
        });
    });

    it("keeps the previous data when a later call fails", async () => {
        await createRoot(async (dispose) => {
            let calls = 0;
            const client: ActionClient<typeof runRef> = {
                action: () => {
                    calls += 1;

                    return calls === 1 ? Promise.resolve({ code: 0 }) : Promise.reject(new Error("refused"));
                },
            };

            const handle = createActionForClient(client, runRef);

            await handle.call({ command: "lunora" });

            expect(handle.data()).toStrictEqual({ code: 0 });

            await expect(handle.call({ command: "bash" })).rejects.toThrow("refused");

            // The adapter-wide contract: a failure sets `error` and leaves the
            // last successful `data` in place.
            expect(handle.error()?.message).toBe("refused");
            expect(handle.data()).toStrictEqual({ code: 0 });

            dispose();
        });
    });
});
