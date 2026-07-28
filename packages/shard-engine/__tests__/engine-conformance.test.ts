import { describe, expect, it } from "vitest";

import { defineEngineContractSuite } from "../src/conformance";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The engine contract suite, run against a `node:sqlite`-backed `ShardHost`.
 *
 * This is the reference run: it proves the suite is executable and that the
 * engine's guarantees hold on the simplest possible host. The Cloudflare run
 * lives in `@lunora/do`'s workerd project, where a real Durable Object supplies
 * the host — same suite, different `factory`.
 */

/**
 * The minimum `ShardHost` these legs touch.
 *
 * Deliberately not a full host: the suite should need only what it asserts, so
 * a gap shows up as a missing member rather than as a passing test that never
 * exercised the seam.
 */
const referenceHost = () => {
    const harness = createSqliteExec();

    return {
        close: () => {
            harness.close();
        },
        host: {
            alarms: {
                delete: () => {},
                get: () => null,
                set: () => {},
            },
            runSerialized: async <T>(function_: () => Promise<T>): Promise<T> => function_(),
            sql: harness.sql,
            transaction: async <T>(function_: () => Promise<T>): Promise<T> => function_(),
        } as never,
    };
};

defineEngineContractSuite("node:sqlite reference", referenceHost, { describe, expect, it } as never);
