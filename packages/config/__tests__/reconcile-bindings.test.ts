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
        containers: [],
        durableObjects: [SHARD],
        needsD1: false,
        signals: [],
        usesAi: false,
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

    it("adds the parameterless ai binding when @cirrus/ai is inferred", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesAi: true }));

        expect(result.added).toContain("AI (Workers AI)");
        expect(readConfig().ai.binding).toBe("AI");
    });

    it("does not re-add the ai binding when one already exists", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "ai": { "binding": "AI" },
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ usesAi: true }));

        expect(result.changed).toBe(false);
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

    it("does not warn about storage when an r2_buckets binding already exists", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "app-files" }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ usesStorage: true }));

        expect(result.warnings.join(" ")).not.toMatch(/r2_buckets/u);
    });

    it("does not warn about auth when a DB binding already backs sessions", () => {
        expect.assertions(1);

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

        const result = reconcileWranglerBindings(root, baseInferred({ usesAuth: true }));

        expect(result.warnings.join(" ")).not.toMatch(/SessionDO/u);
    });

    it("reports a missing wrangler file without throwing", () => {
        expect.assertions(2);

        rmSync(join(root, "wrangler.jsonc"));

        const result = reconcileWranglerBindings(root, baseInferred({ durableObjects: [SHARD, SESSION], usesAuth: true }));

        expect(result.changed).toBe(false);
        expect(result.reason).toContain("not found");
    });

    describe("containers", () => {
        const TRANSCODER = {
            bindingName: "CONTAINER_TRANSCODER",
            className: "TranscoderContainer",
            exported: true,
            exportName: "transcoder",
            image: { buildContext: "./containers/transcoder", dockerfilePath: "./containers/transcoder/Dockerfile", kind: "dockerfile" as const },
            instanceType: "standard-1" as const,
            maxInstances: 5,
        };

        it("provisions the containers entry, DO binding, migration class, and observability", () => {
            expect.assertions(6);

            const result = reconcileWranglerBindings(root, baseInferred({ containers: [TRANSCODER] }));

            expect(result.changed).toBe(true);

            const config = readConfig();

            expect(config.containers).toEqual([
                {
                    class_name: "TranscoderContainer",
                    image: "./containers/transcoder/Dockerfile",
                    image_build_context: "./containers/transcoder",
                    instance_type: "standard-1",
                    max_instances: 5,
                },
            ]);
            expect(config.durable_objects.bindings).toContainEqual({ class_name: "TranscoderContainer", name: "CONTAINER_TRANSCODER" });
            expect(config.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? [])).toContain(
                "TranscoderContainer",
            );
            expect(config.observability).toEqual({ enabled: true });
            // The hand-written comment must survive the structural edits.
            expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toContain("a hand-written comment");
        });

        it("is idempotent — a second run is a no-op", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ containers: [TRANSCODER] }));

            const second = reconcileWranglerBindings(root, baseInferred({ containers: [TRANSCODER] }));

            expect(second.changed).toBe(false);
        });

        it("skips an unexported container and warns instead", () => {
            expect.assertions(3);

            const result = reconcileWranglerBindings(root, baseInferred({ containers: [{ ...TRANSCODER, exported: false }] }));

            expect(result.changed).toBe(false);
            expect(result.warnings.join(" ")).toContain("not exported by the worker entry");
            expect(readConfig().containers).toBeUndefined();
        });

        it("respects an explicit observability opt-out, with a warning", () => {
            expect.assertions(2);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                `{
    "name": "cirrus-app",
    "compatibility_date": "2026-04-07",
    "observability": { "enabled": false },
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`,
                "utf8",
            );

            const result = reconcileWranglerBindings(root, baseInferred({ containers: [TRANSCODER] }));

            expect(readConfig().observability).toEqual({ enabled: false });
            expect(result.warnings.join(" ")).toContain("observability is explicitly disabled");
        });

        it("writes a registry image without a build context", () => {
            expect.assertions(1);

            const registryContainer = { ...TRANSCODER, image: { kind: "registry" as const, reference: "docker.io/acme/transcoder:1.4" } };

            reconcileWranglerBindings(root, baseInferred({ containers: [registryContainer] }));

            expect(readConfig().containers).toEqual([
                { class_name: "TranscoderContainer", image: "docker.io/acme/transcoder:1.4", instance_type: "standard-1", max_instances: 5 },
            ]);
        });

        it("writes a custom instance type with wrangler field names", () => {
            expect.assertions(1);

            const customContainer = { ...TRANSCODER, instanceType: { memoryMib: 4096, vcpu: 1 } };

            reconcileWranglerBindings(root, baseInferred({ containers: [customContainer] }));

            expect(readConfig().containers[0].instance_type).toEqual({ memory_mib: 4096, vcpu: 1 });
        });
    });
});
