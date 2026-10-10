/**
 * The live release the `workerd` project's halt stub is generated from
 * (`vitest.config.ts` writes `halt-stub.generated.js` from it before the
 * project boots): one SQLite-backed and one KV-backed Durable Object class,
 * plus bindings the stub must drop. The class names are the stub's exports,
 * which `test-worker.ts` re-exports so the runtime hosts them.
 */
import type { DeployManifest } from "../../src/provision-contract";

export const HALT_STUB_REASON = "spend-cap";

export const HALT_STUB_FIXTURE: DeployManifest = {
    bindings: [
        { binding: "PARKED_SQLITE", className: "ParkedSqlite", sqlite: true, type: "durable_object" },
        { binding: "PARKED_KV", className: "ParkedKv", sqlite: false, type: "durable_object" },
        { binding: "FILES", resource: "files", type: "r2" },
        { binding: "JOBS", resource: "jobs", type: "queue_producer" },
        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
    ],
    compatibilityDate: "2026-06-10",
    compatibilityFlags: ["nodejs_compat"],
};
