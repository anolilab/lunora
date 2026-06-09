import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DurableObjectSpec, InferredBindings } from "../src/infer-bindings";
import { reconcileWranglerBindings } from "../src/reconcile-bindings";

const SHARD: DurableObjectSpec = { binding: "SHARD", className: "ShardDO" };
const SCHEDULER: DurableObjectSpec = { binding: "SCHEDULER", className: "SchedulerDO" };
const SESSION: DurableObjectSpec = { binding: "SESSION", className: "SessionDO" };

const baseInferred = (overrides: Partial<InferredBindings> = {}): InferredBindings => {
    return {
        durableObjects: [SHARD],
        needsD1: false,
        signals: [],
        usesAuth: false,
        usesScheduler: false,
        usesStorage: false,
        ...overrides,
    };
};

const MINIMAL_WRANGLER = `{
    // a hand-written comment that must survive reconciliation
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`;

describe("reconcileWranglerBindings", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "cirrus-reconcile-"));
        writeFileSync(join(root, "wrangler.jsonc"), MINIMAL_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const readConfig = (): Record<string, any> => parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as Record<string, any>;

    it("is a no-op when the only exported DO is already bound", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred());

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("in sync");
    });

    it("binds a newly-exported SCHEDULER DO and registers its migration class", () => {
        expect.assertions(4);

        const result = reconcileWranglerBindings(root, baseInferred({ durableObjects: [SHARD, SCHEDULER] }));

        expect(result.changed).toBe(true);
        expect(result.added).toContain("SCHEDULER/SchedulerDO");

        const config = readConfig();

        expect(config.durable_objects.bindings.map((binding: { name: string }) => binding.name)).toEqual(["SHARD", "SCHEDULER"]);
        expect(config.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? [])).toContain("SchedulerDO");
    });

    it("adds the DB binding when a global schema is inferred, and warns about the placeholder id", () => {
        expect.assertions(3);

        const result = reconcileWranglerBindings(root, baseInferred({ needsD1: true }));

        expect(result.added).toContain("DB (D1)");
        expect(readConfig().d1_databases[0].binding).toBe("DB");
        expect(result.warnings.join(" ")).toMatch(/placeholder database_id/u);
    });

    it("does not re-add or re-warn for a DB binding that already exists", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-id" }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ needsD1: true }));

        expect(result.changed).toBe(false);
        expect(result.warnings.join(" ")).not.toMatch(/placeholder/u);
    });

    it("preserves user comments through the structural edit", () => {
        expect.assertions(1);

        reconcileWranglerBindings(root, baseInferred({ durableObjects: [SHARD, SCHEDULER] }));

        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toContain("a hand-written comment that must survive");
    });

    it("is idempotent: a second run makes no further changes", () => {
        expect.assertions(2);

        const inferred = baseInferred({ durableObjects: [SHARD, SCHEDULER, SESSION] });
        const first = reconcileWranglerBindings(root, inferred);

        expect(first.changed).toBe(true);

        const second = reconcileWranglerBindings(root, inferred);

        expect(second.changed).toBe(false);
    });

    it("warns rather than guesses when @cirrus/storage is used", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesStorage: true }));

        expect(result.warnings.join(" ")).toMatch(/r2_buckets/u);
        expect(readConfig().r2_buckets).toBeUndefined();
    });

    it("warns when auth is used but no SessionDO is exported, without binding SESSION", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesAuth: true }));

        expect(result.warnings.join(" ")).toMatch(/SessionDO/u);
        expect(readConfig().durable_objects.bindings.some((binding: { name: string }) => binding.name === "SESSION")).toBe(false);
    });

    it("reports a missing wrangler file without throwing", () => {
        expect.assertions(2);

        rmSync(join(root, "wrangler.jsonc"));

        const result = reconcileWranglerBindings(root, baseInferred({ durableObjects: [SHARD, SESSION], usesAuth: true }));

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("not found");
    });
});
