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
import { pollJobDispatched, waitPastTarget } from "@lunora/platform/conformance";

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

    /**
     * Terminal teardown: closes the shard's `better-sqlite3` connection,
     * clears every scheduler job timer, and closes the registry. Doubles as
     * `cleanup` (the suite's per-test reset) and `disposeTerminally` (the
     * post-dispose leg's opt-in hook) because, unlike Cloudflare's DO-backed
     * host, this one has no distinct "soft reset" — every dispose here is
     * terminal, so the same function answers both.
     */
    const cleanup = (): void => {
        // Route through the same disposers `createNodePlatform`'s `close()`
        // uses, mirroring the reference host's `cleanup` (`clearTimeout` on
        // the alarm, plus every scheduled job's timer) rather than just
        // `database.close()`. A bare `database.close()` left the alarm
        // timeout and every armed scheduler job timer alive — handles that
        // keep the event loop open — which is what produced the "worker
        // process failed to exit gracefully" / up-to-10s delay closing out
        // a TCK run.
        // Scheduler first, matching `createNodePlatform.close()`: `disposeShard`
        // closes the connection, and a job timer that fired in the window
        // would find it closed. Both are guarded, but ordering makes the
        // guard the backstop rather than the mechanism.
        disposeScheduler();
        disposeShard();
        registry.close();
    };

    return {
        awaitAlarmFired: async (target) => waitPastTarget(target),
        awaitJobDispatched: async (id) => pollJobDispatched(scheduler, dispatched, id),
        cleanup,
        directory,
        disposeTerminally: cleanup,
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
