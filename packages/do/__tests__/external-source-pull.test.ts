import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { ExternalSourceLike, SourceClientLike } from "../src/external-source-pull";
import { isSourceDue, liftSourceId, pullExternalSourceTick } from "../src/external-source-pull";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The pull + cadence layer the DO poll alarm runs per sourced table (plan 077).
 * This is the logic the codegen-emitted override now delegates to, so it is tested
 * here rather than only as a code-generation string: the id-lift safety, the
 * cadence gate, and the query → project → materialize round-trip.
 */

describe("liftSourceId", () => {
    it("lifts the default `id` column to `_id` and drops it from the body", () => {
        expect.assertions(1);

        expect(liftSourceId({ body: "hi", id: "d1", title: "Doc" })).toStrictEqual({ _id: "d1", body: "hi", title: "Doc" });
    });

    it("honours a custom id column and a map", () => {
        expect.assertions(1);

        expect(
            liftSourceId(
                { org_id: "o1", title: "Doc", uuid: 42 },
                {
                    idColumn: "uuid",
                    map: (row) => {
                        return { orgId: row.org_id, title: row.title };
                    },
                },
            ),
        ).toStrictEqual({ _id: "42", orgId: "o1", title: "Doc" });
    });

    it("throws on a missing id (loud misconfig, not a silent `_id: undefined`)", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ title: "Doc" })).toThrow('missing id column "id"');
    });

    it("throws on a null id", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ id: null, title: "Doc" })).toThrow('missing id column "id"');
    });

    it("throws on a non-scalar id (would otherwise stringify to [object Object])", () => {
        expect.assertions(1);

        expect(() => liftSourceId({ id: { nested: true }, title: "Doc" })).toThrow("must be a string or number");
    });
});

describe("isSourceDue", () => {
    it("never polls a manual source", () => {
        expect.assertions(2);

        expect(isSourceDue("manual", undefined, 1000)).toBe(false);
        expect(isSourceDue("manual", 0, 10_000_000)).toBe(false);
    });

    it("polls every tick when refresh is omitted", () => {
        expect.assertions(2);

        expect(isSourceDue(undefined, undefined, 1000)).toBe(true);
        expect(isSourceDue(undefined, 999, 1000)).toBe(true);
    });

    it("throttles to the interval for { everyMs }", () => {
        expect.assertions(3);

        expect(isSourceDue({ everyMs: 5000 }, undefined, 1000)).toBe(true); // first poll
        expect(isSourceDue({ everyMs: 5000 }, 1000, 4000)).toBe(false); // 3s < 5s
        expect(isSourceDue({ everyMs: 5000 }, 1000, 6000)).toBe(true); // 5s elapsed
    });
});

describe("pullExternalSourceTick", () => {
    const schema: SchemaLike = {
        tables: { documents: { indexes: [], shape: { orgId: { kind: "string" }, title: { kind: "string" } } } },
    };

    let harness: ReturnType<typeof createSqliteExec>;

    const setupWriter = (): DatabaseWriterLike => {
        runShardMigrations(harness.sql, schema, { cdc: true });

        return createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("queries under tenantBy(shardKey), projects, and materializes the slice", async () => {
        expect.assertions(3);

        const writer = setupWriter();
        let calledWith: [string, ReadonlyArray<unknown> | undefined] | undefined;

        const client: SourceClientLike = {
            query: (async (text: string, parameters?: ReadonlyArray<unknown>) => {
                calledWith = [text, parameters];

                return [
                    { id: "d1", org_id: "tenant-a", title: "One" },
                    { id: "d2", org_id: "tenant-a", title: "Two" },
                ];
            }) as SourceClientLike["query"],
        };

        const source: ExternalSourceLike = {
            binding: "HD",
            map: (row) => {
                return { orgId: row.org_id, title: row.title };
            },
            query: "select id, title, org_id from documents where org_id = $1",
            tenantBy: (shardKey) => [shardKey],
        };

        const result = await pullExternalSourceTick(harness.sql, writer, client, "documents", source, "tenant-a");

        // The shard key bound into the query params (the tenant boundary).
        expect(calledWith).toStrictEqual(["select id, title, org_id from documents where org_id = $1", ["tenant-a"]]);
        expect(result.applied).toBe(2);

        const ids = (harness.sql.exec("SELECT id FROM documents ORDER BY id").toArray() as { id: string }[]).map((row) => row.id);

        expect(ids).toStrictEqual(["d1", "d2"]);
    });

    it("aborts the whole tick on a row with a missing id (no partial corruption under `undefined`)", async () => {
        expect.assertions(2);

        const writer = setupWriter();
        const client: SourceClientLike = {
            query: (async () => [
                { id: "d1", orgId: "t", title: "ok" },
                { orgId: "t", title: "no-id" },
            ]) as SourceClientLike["query"],
        };
        const source: ExternalSourceLike = { binding: "HD", query: "select …" };

        await expect(pullExternalSourceTick(harness.sql, writer, client, "documents", source, "__root__")).rejects.toThrow('missing id column "id"');

        // The diff is computed before any apply, so a bad row leaves the table untouched.
        expect(harness.sql.exec("SELECT id FROM documents").toArray()).toStrictEqual([]);
    });
});
