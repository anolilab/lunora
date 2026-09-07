/**
 * Runs the `@lunora/platform-conformance` TCK against the **Cloudflare** host
 * adapters (`createShardHost` / `createSocketHost` / `createShardDirectory`)
 * inside a real `workerd` process.
 *
 * This is the point of the platform seam: the same behavioral suite that pins
 * the in-memory reference host now pins the Cloudflare one, so "the engine can
 * be mounted on another host" is an assertion rather than a claim. Anything the
 * adapters get wrong — a transaction that doesn't roll back, a tagged fan-out
 * that returns a superset, a socket id that isn't stable — fails here against
 * workerd's real SQLite, real hibernation API, and real DO namespace.
 *
 * Mechanics: the suite's `it` is injected, so every test body is wrapped in
 * `runInDurableObject`. That is what gives the factory a genuine
 * `DurableObjectState` (`storage.sql`, `blockConcurrencyWhile`,
 * `acceptWebSocket`, `getTags`) instead of a hand-rolled double — the whole
 * reason this suite lives in the workerd project and not the mocks one.
 *
 * Three contracts are reported as gaps rather than asserted, all honestly:
 *
 * - **Alarm delivery.** Cloudflare fires an alarm by waking a *separate*
 * `alarm()` invocation, which cannot be observed from inside the shard
 * callback holding the input gate. The host omits `awaitAlarmFired`, so the
 * suite asserts the set/read/delete half — the part the adapter owns — and
 * leaves delivery to workerd.
 * - **`SchedulerHost`.** `@lunora/do` implements the shard/socket half of the
 * platform; the Cloudflare scheduler lives in `@lunora/scheduler`. The suite
 * records the gap. Assembling all four contracts under one TCK run is
 * `@lunora/platform-cloudflare`'s job.
 * - **Mid-mutation isolation.** The host declares `isolatesByDispatch`, so the
 * suite skips the leg that reads a shard mid-mutation from "outside". Inside
 * one Durable Object event there is no outside: `blockConcurrencyWhile` closes
 * the input gate, so a same-event read shares the open `storage.transaction`
 * and a second event is never delivered to be read from.
 */
import type { ConformanceHost } from "@lunora/platform/conformance";
import { defineHostContractSuite } from "@lunora/platform/conformance/suite";
import { createShardDirectory, createShardPlatform } from "@lunora/platform-cloudflare";
import { env, runInDurableObject } from "cloudflare:test";
import type { TestContext } from "vitest";
import { describe, expect, it } from "vitest";

/**
 * The `DurableObjectState` of the object the current test body is running
 * inside. Set by the `it` wrapper immediately before the body runs, and read by
 * the factory the suite calls from within it.
 */
let currentState: DurableObjectState | undefined;

/**
 * Sockets minted for the running test. Held so the client end of each
 * `WebSocketPair` stays reachable — dropping it would let the runtime tear the
 * accepted server end down mid-test. Nothing ever reads this list; being
 * referenced is the entire job.
 */
// eslint-disable-next-line sonarjs/no-unused-collection, vitest/require-hook -- write-only by design: a module-scope GC anchor for the client ends of in-flight WebSocketPairs, reset per test by the `it` wrapper
let liveSockets: WebSocket[] = [];

const createCloudflareHost = (): ConformanceHost => {
    const state = currentState;

    if (state === undefined) {
        throw new Error("no DurableObjectState in scope — the conformance body ran outside runInDurableObject");
    }

    const platform = createShardPlatform(state);

    return {
        cleanup: () => {
            // Leave no armed alarm behind: the suite's alarm test schedules one
            // ~50 ms out, and a later test in the same object would otherwise be
            // interrupted by that wake-up.
            // eslint-disable-next-line no-void -- `cleanup` is synchronous by contract and the suite never awaits it; disarming is fire-and-forget
            void state.storage.deleteAlarm();
            liveSockets = [];
        },
        createSocket: () => {
            const pair = new WebSocketPair();

            liveSockets.push(pair[0], pair[1]);

            return pair[1];
        },
        // Built through the composition root, not the individual adapters, so
        // this TCK run covers BOTH: the adapters' behaviour and the assembly
        // `createShardPlatform` performs. A wiring mistake in the root — the
        // wrong storage handle into `kv`, say — fails here, not in production.
        directory: createShardDirectory(env.ECHO as unknown as Parameters<typeof createShardDirectory>[0]),
        // `runSerialized` is `blockConcurrencyWhile`: the input gate, not the
        // SQL executor, is where this host keeps concurrent tasks apart. See
        // the `isolatesByDispatch` note on `ConformanceHost` for what that
        // costs the isolation leg and what still covers it.
        isolatesByDispatch: true,
        kv: platform.kv,
        shard: platform.shard,
        socket: platform.sockets,
    };
};

/**
 * `it`, but the body runs inside a fresh Durable Object. Each test gets its own
 * object so SQL tables, sockets, and alarms from one never bleed into the next.
 *
 * The real vitest `TestContext` is forwarded into `body` (plan 268, W2): the
 * suite's dynamic-skip legs call `context.skip()`, which only works against
 * the context the runner itself created for this test — a context this
 * wrapper invented would not be wired to anything the runner recognizes.
 */
const itInDurableObject = ((name: string, body: (context: TestContext) => Promise<void> | void) => {
    // The assertions live in the injected suite's bodies, not here — this
    // wrapper only supplies the Durable Object context they run in.
    // eslint-disable-next-line vitest/expect-expect, vitest/require-top-level-describe, vitest/prefer-expect-assertions, sonarjs/assertions-in-tests -- generic test-runner adapter; `defineHostContractSuite` owns the describe blocks and the assertions
    it(name, async (context) => {
        const stub = env.SHARD.get(env.SHARD.newUniqueId());

        await runInDurableObject(stub, async (_instance, state) => {
            currentState = state;

            try {
                await body(context);
            } finally {
                currentState = undefined;
                liveSockets = [];
            }
        });
    });
}) as unknown as typeof it;

// eslint-disable-next-line vitest/require-hook -- `defineHostContractSuite` *is* the suite: it registers describe/it blocks at module scope, which is exactly where they belong
defineHostContractSuite("cloudflare (@lunora/do)", createCloudflareHost, { describe, expect, it: itInDurableObject });
