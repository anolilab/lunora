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
import { createNodeShardDirectory } from "../node-shard-directory";
import { createNodeShardHost } from "../node-shard-host";
import { createNodeSocketHost } from "../node-socket-host";

/**
 * Build a fresh, isolated Node host for one TCK run, backed by an in-memory
 * (`:memory:`) `better-sqlite3` database — every run gets a private database,
 * the same isolation the reference host's fresh `node:sqlite` connection
 * gives, and fast because there is no file I/O.
 */
export const createNodeConformanceHost = (): ConformanceHost => {
    const { database, host: shard } = createNodeShardHost();
    const kv = createNodeShardKvStore(database);
    const directory = createNodeShardDirectory();
    const { readFrames, restoreSocket, simulateRecycle, socket } = createNodeSocketHost();
    const { scheduler, simulateDeadLetter } = createNodeSchedulerHost();

    return {
        awaitAlarmFired: async (target) => {
            // Same wait-past-target strategy the reference host uses: the alarm
            // clears itself from a real `setTimeout`, so waiting slightly past
            // the target is sufficient to observe the transition.
            await new Promise((resolve) => {
                setTimeout(resolve, Math.max(0, target - Date.now()) + 30);
            });
        },
        cleanup: () => {
            database.close();
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
