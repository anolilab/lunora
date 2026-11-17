/**
 * The TTL sweep's page scan and per-row recheck over a real Durable Object's
 * `state.storage.sql`. The sweep deletes only rows the recheck still sees as
 * expired, so both statements have to agree on the engine that runs them.
 */
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { createShardCtxDb } from "../../src/ctx-db";
import { runShardMigrations } from "../../src/ctx-db-migrations";
import type { SchemaLike } from "../../src/schema-types";
import type { TtlSweepSpec } from "../../src/ttl-sweep";
import { isTtlExpired, selectExpiredIds } from "../../src/ttl-sweep";
import type { SqlHarness } from "../_helpers/sql-harness";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

const NOW = 1_700_000_000_000;
const AFTER = 30_000;

const schema: SchemaLike = {
    tables: {
        presence: {
            indexes: [],
            shape: { deletedAt: { kind: "number" }, lastSeen: { kind: "number" } },
            softDeleteMode: { field: "deletedAt" },
            ttlPolicy: { after: AFTER, field: "lastSeen" },
        },
    },
};

const spec: TtlSweepSpec = { after: AFTER, field: "lastSeen", softDeleteField: "deletedAt", table: "presence" };

let harness: SqlHarness;

describe("ttl sweep on workerd SQLite", () => {
    beforeEach(() => {
        harness = createWorkerdExec();
        runShardMigrations(harness.sql, schema);
    });

    it("rechecks a selected row as live once its ttl field is refreshed", async () => {
        expect.assertions(3);

        const writer = createShardCtxDb({ clock: () => NOW, schema, sql: harness.sql });

        await writer.insert("presence", { _id: "a", lastSeen: NOW - 2 * AFTER }, { allowExplicitId: true });
        await writer.insert("presence", { _id: "b", lastSeen: NOW - 2 * AFTER }, { allowExplicitId: true });

        const { ids } = selectExpiredIds(harness.sql, spec, NOW, 10);

        await writer.patch("presence", "b", { lastSeen: NOW });

        expect(ids.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["a", "b"]);
        expect(isTtlExpired(harness.sql, spec, "a", NOW)).toBe(true);
        expect(isTtlExpired(harness.sql, spec, "b", NOW)).toBe(false);
    });

    it("treats a soft-deleted row as no longer expired", async () => {
        expect.assertions(1);

        const writer = createShardCtxDb({ clock: () => NOW, schema, sql: harness.sql });

        await writer.insert("presence", { _id: "a", lastSeen: NOW - 2 * AFTER }, { allowExplicitId: true });
        await writer.delete("presence", "a");

        expect(isTtlExpired(harness.sql, spec, "a", NOW)).toBe(false);
    });
});
