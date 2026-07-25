/**
 * Runs the `@lunora/platform-conformance` TCK against the **composed**
 * Cloudflare platform in real workerd.
 *
 * `@lunora/do` already runs the suite against its individual adapters. This run
 * is different in the way that matters: it asserts the host an app actually
 * gets from `createShardPlatform` / `createWorkerPlatform`, with a real
 * `SchedulerDO` bound — so every contract, scheduler included, is exercised in
 * one place. Before this existed the scheduler leg reported an unimplemented
 * gap on every run.
 *
 * Mechanics mirror `@lunora/do`'s harness: the suite's `it` is injected so each
 * body runs inside `runInDurableObject`, which is what supplies a genuine
 * `DurableObjectState` rather than a hand-rolled double.
 */
import type { ConformanceHost } from "@lunora/platform-conformance";
import { defineHostContractSuite } from "@lunora/platform-conformance/suite";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createShardPlatform, createWorkerPlatform } from "../../src";

/** The state of the Durable Object the current test body runs inside. */
let currentState: DurableObjectState | undefined;

/**
 * Client ends of minted socket pairs, held so the runtime does not tear down the
 * accepted server end mid-test. Write-only by design.
 */
// eslint-disable-next-line sonarjs/no-unused-collection, vitest/require-hook -- a module-scope GC anchor for in-flight WebSocketPairs, reset per test by the `it` wrapper
let liveSockets: WebSocket[] = [];

const createHost = (): ConformanceHost => {
    const state = currentState;

    if (state === undefined) {
        throw new Error("no DurableObjectState in scope — the conformance body ran outside runInDurableObject");
    }

    // The composed platform: exactly what an app constructs.
    const shardPlatform = createShardPlatform(state);
    const workerPlatform = createWorkerPlatform(env, {
        scheduler: { originUrl: "https://worker.test" },
    });

    return {
        cleanup: () => {
            // Leave no armed alarm behind for the next test in this object.
            // eslint-disable-next-line no-void -- `cleanup` is sync by contract and never awaited; disarming is fire-and-forget
            void state.storage.deleteAlarm();
            liveSockets = [];
        },
        createSocket: () => {
            const pair = new WebSocketPair();

            liveSockets.push(pair[0], pair[1]);

            return pair[1];
        },
        directory: workerPlatform.directory("ECHO"),
        kv: shardPlatform.kv,
        scheduler: workerPlatform.scheduler,
        shard: shardPlatform.shard,
        socket: shardPlatform.sockets,
    };
};

/** `it`, but each body runs inside a fresh Durable Object. */
const itInDurableObject = ((name: string, body: () => Promise<void> | void) => {
    // eslint-disable-next-line vitest/expect-expect, vitest/require-top-level-describe, vitest/prefer-expect-assertions, sonarjs/assertions-in-tests -- generic runner adapter; `defineHostContractSuite` owns the describes and the assertions
    it(name, async () => {
        const stub = env.SHARD.get(env.SHARD.newUniqueId());

        await runInDurableObject(stub, async (_instance, state) => {
            currentState = state;

            try {
                await body();
            } finally {
                currentState = undefined;
                liveSockets = [];
            }
        });
    });
}) as unknown as typeof it;

// eslint-disable-next-line vitest/require-hook -- `defineHostContractSuite` IS the suite: it registers describe/it at module scope, which is where they belong
defineHostContractSuite("cloudflare (composed platform)", createHost, { describe, expect, it: itInDurableObject });
