import { bench, describe } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * `orchestrateMigration` and `orchestrateExport` are the QueryCoordinator's
 * fan-out siblings — same registry → bounded `Promise.all` → roll-up shape
 * as `orchestrateImport` and `fanOut`, but each handles a different admin
 * payload. We bench both at N=4 and N=16 shards so:
 *
 * - regressions in the bounded-fanout helper are visible across all three
 * orchestrate* paths (they share the runner), and
 * - the per-orchestrator overhead (admin-payload shape, roll-up shape) is
 * isolated.
 *
 * In-process shard stubs return instantly so the bench isolates
 * orchestration cost, not network IO.
 */

const makeShardStub = (payload: unknown): ShardNamespaceLike => {
    const stub = {
        async fetch(): Promise<Response> {
            return Response.json(payload, { status: 200 });
        },
    };

    return {
        get: () => stub,
        getByName: () => stub,
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

interface MigrateSetup {
    coordinator: ReturnType<typeof createQueryCoordinator>;
    namespace: ShardNamespaceLike;
}

const buildMigrateSetup = (count: number): MigrateSetup => {
    const shardKeys = Array.from({ length: count }, (_, index) => `s${String(index)}`);

    return {
        coordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ todos: shardKeys }) }),
        namespace: makeShardStub({ changed: 10, failed: 0, ok: 10, processed: 10, shards: [], status: "completed" }),
    };
};

interface ExportSetup {
    coordinator: ReturnType<typeof createQueryCoordinator>;
    namespace: ShardNamespaceLike;
}

const buildExportSetup = (count: number, rowsPerShard: number): ExportSetup => {
    const shardKeys = Array.from({ length: count }, (_, index) => `s${String(index)}`);
    const rows = Array.from({ length: rowsPerShard }, (_, index) => {
        return {
            doc: { _id: `t${String(index)}`, projectId: "p1", seq: index },
            table: "todos",
        };
    });

    return {
        coordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ todos: shardKeys }) }),
        namespace: makeShardStub({ rows }),
    };
};

const migrate4 = buildMigrateSetup(4);
const migrate16 = buildMigrateSetup(16);
const export4 = buildExportSetup(4, 250);
const export16 = buildExportSetup(16, 62);

describe("orchestrateMigration — admin RPC fan-out", () => {
    bench("4 shards", async () => {
        await migrate4.coordinator.orchestrateMigration(migrate4.namespace, {
            args: { direction: "up", id: "backfill" },
            functionPath: "__cirrus_admin__:runMigration",
            table: "todos",
        });
    });

    bench("16 shards", async () => {
        await migrate16.coordinator.orchestrateMigration(migrate16.namespace, {
            args: { direction: "up", id: "backfill" },
            functionPath: "__cirrus_admin__:runMigration",
            table: "todos",
        });
    });
});

describe("orchestrateExport — admin RPC fan-out (1000 rows total)", () => {
    bench("4 shards × 250 rows", async () => {
        await export4.coordinator.orchestrateExport(export4.namespace, { tables: ["todos"] });
    });

    bench("16 shards × 62 rows", async () => {
        await export16.coordinator.orchestrateExport(export16.namespace, { tables: ["todos"] });
    });
});
