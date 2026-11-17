import type { DestroyRef } from "@angular/core";
import type { LunoraClient } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { AdapterDriver, Mounted } from "../../client/__tests__/lib/adapter-scenarios";
import { PRESENCE, scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import { liveQuery } from "../src/live-query";
import { mutate } from "../src/mutate";
import { presence } from "../src/presence";
import { subscription } from "../src/subscription";
import { createFakeDestroyRef } from "./fake-client";

/** Open with an explicit `DestroyRef` (no `TestBed`, as in `presence.test.ts`); dispose fires it like a component destroy. */
const mount = <T>(open: (destroyRef: DestroyRef) => () => T): Mounted<T> => {
    const destroy = createFakeDestroyRef();

    return { current: open(destroy.asDestroyRef), dispose: destroy.destroy };
};

const driver: AdapterDriver = {
    act: async (fn) => {
        await fn();
    },
    // `mutate` is a plain call with no lifetime of its own, so there is nothing to dispose.
    mutation: (client, ref) => {
        const run = async (args: Record<string, unknown>): Promise<unknown> => mutate(ref, args, { client: client as LunoraClient });

        return { current: () => run, dispose: () => undefined };
    },
    presence: (client, { intervalMs }) =>
        mount(
            (destroyRef) =>
                presence(PRESENCE.roomId, {
                    client: client as LunoraClient,
                    destroyRef,
                    heartbeat: PRESENCE.heartbeat,
                    intervalMs,
                    listPresent: PRESENCE.listPresent,
                    sessionId: PRESENCE.sessionId,
                }).present,
        ),
    query: (client, ref, args, options) => mount((destroyRef) => liveQuery(ref, args, { ...options, client: client as LunoraClient, destroyRef })),
    subscription: (client, ref, args, { onError }) =>
        mount((destroyRef) => subscription(ref, args, { client: client as LunoraClient, destroyRef, onError }).data),
};

describe("@lunora/angular behavioural parity", () => {
    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
