/**
 * Assemble a `@lunora/platform/conformance` `ConformanceHost` from the Node
 * adapters in this package, so `defineHostContractSuite` can run the existing
 * TCK against this host exactly as it does against the `node:sqlite`
 * reference host and (via `@lunora/do`'s workerd project) Cloudflare.
 *
 * This is test-only wiring, not the package's public composition root — see
 * `createNodePlatform` in `../node-platform` for the shape app code would
 * actually consume.
 */

import type { ConformanceHost } from "@lunora/platform/conformance";

import { createNodeShardKvStore } from "../node-kv-store";
import { createNodeSchedulerHost } from "../node-scheduler-host";
import { createNodeShardHost } from "../node-shard-host";
import { createNodeShardRegistry } from "../node-shard-registry";
import { createNodeSocketHost } from "../node-socket-host";

/**
 * Build a fresh, isolated Node host for one TCK run, backed by an in-memory
 * (`:memory:`) `better-sqlite3` database — every run gets a private database,
 * the same isolation the reference host's fresh `node:sqlite` connection
 * gives, and fast because there is no file I/O.
 */
export const createNodeConformanceHost = (): ConformanceHost => {
    const { database, dispose: disposeShard, host: shard } = createNodeShardHost();
    const kv = createNodeShardKvStore(database);
    const registry = createNodeShardRegistry();
    const { directory } = registry;
    const { readFrames, restoreSocket, simulateRecycle, socket } = createNodeSocketHost(database);

    /**
     * Job ids this host actually delivered.
     *
     * The TCK's "dispatches a scheduled job at least once" leg exists because a
     * host can expire a timer without ever invoking its delivery path — which is
     * exactly what this host used to do, and why plan 267 rated its scheduler
     * `unsupported`. Recording ids from a real `onDispatch` is what lets the
     * suite tell delivery apart from expiry, so this wiring is the evidence for
     * the `deadLetter` member being declared at all.
     */
    const dispatched = new Set<string>();
    const {
        dispose: disposeScheduler,
        scheduler,
        simulateDeadLetter,
    } = createNodeSchedulerHost(database, {
        onDispatch: (_functionPath, _args, job) => {
            dispatched.add(job.id);
        },
    });

    return {
        awaitAlarmFired: async (target) => {
            // Same wait-past-target strategy the reference host uses: the alarm
            // clears itself from a real `setTimeout`, so waiting slightly past
            // the target is sufficient to observe the transition.
            await new Promise((resolve) => {
                setTimeout(resolve, Math.max(0, target - Date.now()) + 30);
            });
        },
        awaitJobDispatched: async (id) => {
            // Same wait-past-target strategy as `awaitAlarmFired`: read the
            // job's own `scheduledFor` while it is still pending and wait
            // slightly past it. A job already gone from `list()` either fired or
            // never existed, and `dispatched` distinguishes those two.
            const listed = await scheduler.list?.();
            const pending = listed?.find((entry) => entry.id === id);

            if (pending !== undefined) {
                await new Promise((resolve) => {
                    setTimeout(resolve, Math.max(0, pending.scheduledFor - Date.now()) + 30);
                });
            }

            return dispatched.has(id);
        },
        cleanup: () => {
            // Route through the same disposers `createNodePlatform`'s `close()`
            // uses, mirroring the reference host's `cleanup` (`clearTimeout` on
            // the alarm, plus every scheduled job's timer) rather than just
            // `database.close()`. A bare `database.close()` left the alarm
            // timeout and every armed scheduler job timer alive — handles that
            // keep the event loop open — which is what produced the "worker
            // process failed to exit gracefully" / up-to-10s delay closing out
            // a TCK run.
            disposeShard();
            disposeScheduler();
            registry.close();
        },
        directory,
        kv,
        readFrames,
        restoreSocket,
        scheduler,
        shard,
        simulateDeadLetter,
        simulateRecycle,
        socket,
    };
};
