import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WranglerConfig } from "../src/wrangler-validator";
import {
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWrangler,
    validateWranglerConfig,
    validateWranglerProject,
    withTailConsumer,
} from "../src/wrangler-validator";

const SHARD_BINDING_ERROR_RE = /SHARD.+ShardDO/u;
const WRANGLER_NOT_FOUND_RE = /wrangler\.jsonc not found/u;

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    }).global(),
});
`;

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const SCHEMA_WITH_VECTOR = `import { defineSchema, defineTable, v } from "@lunora/server";
import { embed } from "../app/embed";

export const schema = defineSchema({
    docs: defineTable({
        body: v.string(),
        workspaceId: v.id("workspaces"),
    })
        .shardBy("workspaceId")
        .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", embed }),
});
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["nodejs_compat", "${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-global", "database_id": "x" }]
}
`;

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), source, "utf8");
};

describe("wrangler-validator", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-config-wrangler-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("validateWranglerConfig (pure)", () => {
        it("returns valid:true when all required bindings/flags are present", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("reports the SHARD binding when missing", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not require the compatibility flag when compatibility_date is recent enough", () => {
            expect.assertions(2);

            // web_socket_auto_reply_to_close became the default on REQUIRED_COMPATIBILITY_DATE,
            // so it should not be required (and workerd warns when it's set redundantly).
            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: ["nodejs_compat"],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.valid).toBe(true);
            expect(report.errors.some((line) => line.includes(REQUIRED_FLAG))).toBe(false);
        });

        it("reports a malformed compatibility_date that is not YYYY-MM-DD", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: "2026-4-7",
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("YYYY-MM-DD"))).toBe(true);
        });

        it("does not throw and reports a tail_consumers entry that is null", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                tail_consumers: [null],
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("tail_consumers[0]"))).toBe(true);
        });

        it("does not throw when a vectorize entry is null", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vectorize: [null],
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

            // The null entry is skipped; the declared index is simply unmatched.
            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("does not throw when durable_objects.bindings contains a null entry (JSONC trailing comma)", () => {
            expect.assertions(2);

            // `"durable_objects": { "bindings": [null] }` — a stray trailing comma in JSONC
            // parses to exactly this. The validator must report the missing SHARD binding,
            // not crash with a raw TypeError dereferencing `binding.name`.
            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [null] },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not throw when durable_objects.bindings is a non-array value", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: "SHARD" },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not throw when d1_databases contains a null entry for a global-table schema", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                d1_databases: [null],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: true, vectorIndexNames: [] });

            // The null entry is skipped; the missing "DB" binding is reported structurally.
            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("rejects a wildcard CORS origin paired with credentials in vars", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "https://app.example.com, *", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(true);
        });

        it("allows a wildcard origin without credentials, and credentials without a wildcard", () => {
            expect.assertions(2);

            const wildcardOnly = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "*" },
            });

            const credentialsOnly = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "https://app.example.com", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
            });

            expect(wildcardOnly.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
            expect(credentialsOnly.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
        });

        it("does not throw when vars is absent or non-string", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: 123, LUNORA_CORS_ALLOW_CREDENTIALS: true },
            });

            expect(report.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
        });

        it("reports an outdated compatibility_date", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: "2024-01-01",
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.errors.some((line) => line.includes("compatibility_date"))).toBe(true);
        });

        it("requires a DB binding when the schema has any .global() table", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: true });

            expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("requires a matching vectorize binding for each declared vector index", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("passes when a vectorize binding declares the index_name", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vectorize: [{ binding: "DOCS_BODY", index_name: "docs-body" }],
            };

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("accepts a well-formed tail_consumers entry", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                tail_consumers: [{ service: "log-forwarder" }],
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("reports a tail_consumers entry missing its service", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                tail_consumers: [{ environment: "production" }],
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("tail_consumers[0]"))).toBe(true);
        });

        it("validateWrangler is an alias for validateWranglerConfig", () => {
            expect.assertions(1);

            expect(validateWrangler).toBe(validateWranglerConfig);
        });

        it("treats a non-object wrangler as invalid", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(undefined);

            expect(report.valid).toBe(false);
            expect(report.errors.length).toBeGreaterThan(0);
        });
    });

    describe("withTailConsumer", () => {
        it("appends a tail consumer when none is wired", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = { compatibility_date: REQUIRED_COMPATIBILITY_DATE };
            const next = withTailConsumer(wrangler, { service: "log-forwarder" });

            expect(next.tail_consumers).toEqual([{ service: "log-forwarder" }]);
            // The input is left untouched (pure).
            expect(wrangler.tail_consumers).toBeUndefined();
        });

        it("is idempotent for the same service + environment", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = { tail_consumers: [{ environment: "production", service: "log-forwarder" }] };
            const next = withTailConsumer(wrangler, { environment: "production", service: "log-forwarder" });

            expect(next).toBe(wrangler);
        });

        it("does not throw when existing tail_consumers contains a null entry", () => {
            expect.assertions(1);

            const wrangler = { tail_consumers: [null] } as unknown as WranglerConfig;
            const next = withTailConsumer(wrangler, { service: "log-forwarder" });

            expect(next.tail_consumers).toHaveLength(2);
        });

        it("adds a distinct entry when the environment differs", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = { tail_consumers: [{ environment: "production", service: "log-forwarder" }] };
            const next = withTailConsumer(wrangler, { environment: "staging", service: "log-forwarder" });

            expect(next.tail_consumers).toHaveLength(2);
        });
    });

    describe("validateWranglerProject (file-system aware)", () => {
        it("passes when wrangler.jsonc declares everything the schema implies", () => {
            expect.assertions(3);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
            expect(result.report.valid).toBe(true);
            expect(result.wranglerPath).toBe(join(workdir, "wrangler.jsonc"));
        });

        it("returns a problem when wrangler.jsonc is missing entirely", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.join("\n")).toMatch(WRANGLER_NOT_FOUND_RE);
            expect(result.wranglerPath).toBeUndefined();
        });

        it("warns (never errors) when assets.directory does not exist yet", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "assets": { "directory": "./dist/client", "binding": "ASSETS" }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(true);
            expect(result.report.warnings.join(" ")).toMatch(/assets\.directory.*does not exist yet/u);
        });

        it("does not warn about assets.directory once the directory exists", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            mkdirSync(join(workdir, "dist", "client"), { recursive: true });
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "assets": { "directory": "./dist/client", "binding": "ASSETS" }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.warnings.join(" ")).not.toMatch(/assets\.directory/u);
        });

        it("does not require D1 when no table is global", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("supports jsonc comments and trailing commas", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `// my wrangler config
{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("returns a problem when SHARD durable-object binding is missing", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("flags a declared .vectorize() index with no matching vectorize binding", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_VECTOR);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("passes when wrangler declares the vectorize binding for the schema's index", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_VECTOR);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "vectorize": [{ "binding": "DOCS_BODY", "index_name": "docs-body" }]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("reports a malformed compatibility_date from disk", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2026-4-7",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(false);
            expect(result.problems.some((line) => line.includes("YYYY-MM-DD"))).toBe(true);
        });

        it("reports a JSONC syntax error as an unparseable config", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), `{ "name": "x", `, "utf8");

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(false);
            expect(result.problems.some((line) => /failed to parse .* as JSONC/u.test(line))).toBe(true);
        });

        it("returns a problem when schema has .global() tables but D1 binding is missing", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("reports a local container image whose Dockerfile does not exist", () => {
            expect.assertions(1);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "observability": { "enabled": true },
    "durable_objects": {
        "bindings": [
            { "name": "SHARD", "class_name": "ShardDO" },
            { "name": "CONTAINER_TRANSCODER", "class_name": "TranscoderContainer" }
        ]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "TranscoderContainer"] }],
    "containers": [{ "class_name": "TranscoderContainer", "image": "./containers/transcoder/Dockerfile", "max_instances": 2 }]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("does not exist"))).toBe(true);
        });
    });

    describe("containers", () => {
        const baseConfig = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                containers: [{ class_name: "TranscoderContainer", image: "./containers/transcoder/Dockerfile", max_instances: 2 }],
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "TranscoderContainer", name: "CONTAINER_TRANSCODER" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO", "TranscoderContainer"] }],
                observability: { enabled: true },
                ...overrides,
            };
        };

        it("accepts a fully wired container", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(baseConfig({}));

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });

        it("requires a matching durable_objects binding", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } }));

            expect(report.errors.join(" ")).toContain("no matching durable_objects binding");
        });

        it("requires the class in new_sqlite_classes and flags new_classes", () => {
            expect.assertions(2);

            const missing = validateWranglerConfig(baseConfig({ migrations: [{ new_sqlite_classes: ["ShardDO"] }] }));

            expect(missing.errors.join(" ")).toContain("missing from migrations");

            const wrongKind = validateWranglerConfig(baseConfig({ migrations: [{ new_classes: ["TranscoderContainer"], new_sqlite_classes: ["ShardDO"] }] }));

            expect(wrongKind.errors.join(" ")).toContain('move it to "new_sqlite_classes"');
        });

        it("rejects an unknown named instance type and out-of-bounds custom values", () => {
            expect.assertions(2);

            const unknownName = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: "mega", max_instances: 1 }],
                }),
            );

            expect(unknownName.errors.join(" ")).toContain('unknown instance_type "mega"');

            const outOfBounds = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { vcpu: 8 }, max_instances: 1 }],
                }),
            );

            expect(outOfBounds.errors.join(" ")).toContain("vcpu must be a positive number");
        });

        it("rejects custom instance types that violate the memory/vcpu and disk/memory ratios", () => {
            expect.assertions(4);

            const tooLittleMemory = validateWranglerConfig(
                baseConfig({
                    containers: [
                        { class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { memory_mib: 4096, vcpu: 4 }, max_instances: 1 },
                    ],
                }),
            );

            expect(tooLittleMemory.errors.join(" ")).toContain("≥ 3 GiB");

            const tooMuchDisk = validateWranglerConfig(
                baseConfig({
                    containers: [
                        { class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { disk_mb: 20_000, memory_mib: 4096 }, max_instances: 1 },
                    ],
                }),
            );

            expect(tooMuchDisk.errors.join(" ")).toContain("≤ 2 GB disk");

            const valid = validateWranglerConfig(
                baseConfig({
                    containers: [
                        {
                            class_name: "TranscoderContainer",
                            image: "./x/Dockerfile",
                            instance_type: { disk_mb: 8000, memory_mib: 8192, vcpu: 2 },
                            max_instances: 1,
                        },
                    ],
                }),
            );

            expect(valid.errors).toEqual([]);
            expect(valid.warnings).toEqual([]);
        });

        it("warns on a missing max_instances cap and disabled observability", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile" }],
                    observability: { enabled: false },
                }),
            );

            expect(report.warnings.join(" ")).toContain("no max_instances");
            expect(report.warnings.join(" ")).toContain("observability is not enabled");
        });

        it("rejects a malformed entry without a class_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ containers: [{ image: "./x/Dockerfile" }] }));

            expect(report.errors.join(" ")).toContain('non-empty "class_name"');
        });
    });

    describe("workflows", () => {
        const baseConfig = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", class_name: "OrderPipelineWorkflow", name: "order-pipeline" }],
                ...overrides,
            };
        };

        it("accepts a well-formed workflows entry — no DO binding or migration required", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(baseConfig({}));

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });

        it("rejects workflows that is not an array", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: {} as never }));

            expect(report.errors.join(" ")).toContain("workflows must be an array");
        });

        it("rejects an entry missing a binding", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ class_name: "OrderPipelineWorkflow", name: "order-pipeline" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("rejects an entry missing a class_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", name: "order-pipeline" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "class_name"');
        });

        it("rejects an entry missing a name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", class_name: "OrderPipelineWorkflow" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "name"');
        });

        it("rejects a non-object entry", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [null] as never }));

            expect(report.errors.join(" ")).toContain("must be a { name, binding, class_name } object");
        });
    });

    // Cloudflare-coverage bindings + config flags (plans 027-043). A minimal
    // valid base (SHARD binding + compat date) keeps each case focused on the
    // new key under test — only its own error/warning should appear.
    describe("cloudflare-coverage bindings", () => {
        const validBase = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                ...overrides,
            };
        };

        it("accepts a well-formed kv_namespaces binding; warns on a missing id; errors on a missing binding", () => {
            expect.assertions(4);

            const valid = validateWranglerConfig(validBase({ kv_namespaces: [{ binding: "CACHE", id: "abc123" }] }));

            expect(valid.valid).toBe(true);

            const missingId = validateWranglerConfig(validBase({ kv_namespaces: [{ binding: "CACHE" }] }));

            expect(missingId.valid).toBe(true);
            expect(missingId.warnings.join(" ")).toMatch(/wrangler kv namespace create/u);

            const missingBinding = validateWranglerConfig(validBase({ kv_namespaces: [{ id: "abc123" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed flagship binding; warns on a missing app_id; errors on a missing binding", () => {
            expect.assertions(4);

            const valid = validateWranglerConfig(validBase({ flagship: [{ app_id: "app-abc", binding: "FLAGS" }] }));

            expect(valid.valid).toBe(true);

            const missingAppId = validateWranglerConfig(validBase({ flagship: [{ binding: "FLAGS" }] }));

            expect(missingAppId.valid).toBe(true);
            expect(missingAppId.warnings.join(" ")).toMatch(/has no "app_id"/u);

            const missingBinding = validateWranglerConfig(validBase({ flagship: [{ app_id: "app-abc" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed hyperdrive binding; warns on a missing id; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ hyperdrive: [{ binding: "HYPERDRIVE", id: "hd_123" }] }));

            expect(valid.valid).toBe(true);

            const missingId = validateWranglerConfig(validBase({ hyperdrive: [{ binding: "HYPERDRIVE" }] }));

            expect(missingId.warnings.join(" ")).toMatch(/wrangler hyperdrive create/u);

            const missingBinding = validateWranglerConfig(validBase({ hyperdrive: [{ id: "hd_123" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed pipelines binding; warns on a missing pipeline; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE", pipeline: "events" }] }));

            expect(valid.valid).toBe(true);

            const missingPipeline = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE" }] }));

            expect(missingPipeline.warnings.join(" ")).toMatch(/wrangler pipelines create/u);

            const missingBinding = validateWranglerConfig(validBase({ pipelines: [{ pipeline: "events" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts `stream`, wrangler's rename of the deprecated `pipeline` field, without warning", () => {
            expect.assertions(2);

            // wrangler deprecation-warns on `pipeline`, so a correctly-wired binding
            // now spells it `stream`; that must not trip the missing-hint warning.
            const stream = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE", stream: "events" }] }));

            expect(stream.valid).toBe(true);
            expect(stream.warnings.join(" ")).not.toMatch(/wrangler pipelines create/u);
        });

        it("accepts a well-formed analytics_engine_datasets binding; warns on a missing dataset; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ binding: "ANALYTICS", dataset: "events" }] }));

            expect(valid.valid).toBe(true);

            const missingDataset = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ binding: "ANALYTICS" }] }));

            expect(missingDataset.warnings.join(" ")).toMatch(/defaults to the binding name/u);

            const missingBinding = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ dataset: "events" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed browser block and flags an empty one", () => {
            expect.assertions(2);

            expect(validateWranglerConfig(validBase({ browser: { binding: "BROWSER" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ browser: {} })).errors.join(" ")).toContain("browser must be an object");
        });

        it("accepts a well-formed images block and flags an empty one", () => {
            expect.assertions(2);

            expect(validateWranglerConfig(validBase({ images: { binding: "IMAGES" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ images: {} })).errors.join(" ")).toContain("images must be an object");
        });

        it("accepts a well-formed services entry and rejects one missing binding or service", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ services: [{ binding: "PRICING", entrypoint: "PricingEntry", service: "pricing-worker" }] })).valid).toBe(
                true,
            );
            expect(validateWranglerConfig(validBase({ services: [{ service: "pricing-worker" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ services: [{ binding: "PRICING" }] })).errors.join(" ")).toContain('must have a non-empty "service"');
        });

        it("accepts a well-formed dispatch_namespaces entry and rejects one missing binding or namespace", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "tenants" }] })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ namespace: "tenants" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER" }] })).errors.join(" ")).toContain(
                'must have a non-empty "namespace"',
            );
        });

        it("does not trip DO/migration cross-checks when only dispatch_namespaces is added", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "tenants" }] }));

            expect(report.errors).toHaveLength(0);
        });

        it("accepts a well-formed mtls_certificates entry and rejects one missing binding or certificate_id", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ binding: "MY_CERT", certificate_id: "cert_1" }] })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ certificate_id: "cert_1" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ binding: "MY_CERT" }] })).errors.join(" ")).toContain(
                'must have a non-empty "certificate_id"',
            );
        });

        it("accepts a well-formed send_email binding and warns (never errors) on one missing name", () => {
            expect.assertions(4);

            expect(validateWranglerConfig(validBase({ send_email: [{ name: "SEND_EMAIL" }] })).valid).toBe(true);

            // A missing `name` is a strictly additive advisory — wrangler reports the
            // authoritative error at deploy, so validation stays valid and only warns.
            const missingName = validateWranglerConfig(validBase({ send_email: [{ destination_address: "ops@example.com" }] }));

            expect(missingName.valid).toBe(true);
            expect(missingName.warnings.join(" ")).toContain('has no non-empty "name"');

            // A wrong *type* is still a malformed shape and errors.
            expect(validateWranglerConfig(validBase({ send_email: {} as never })).errors.join(" ")).toContain("send_email must be an array");
        });

        it("recognizes logpush as a boolean and rejects a non-boolean", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ logpush: true })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({})).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ logpush: "true" as never })).errors.join(" ")).toContain("logpush must be a boolean");
        });

        it("accepts placement.mode smart, and rejects a typo'd mode or wrong shape", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ placement: { mode: "smart" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ placement: { mode: "fast" } })).errors.join(" ")).toContain('placement.mode must be "smart"');
            expect(validateWranglerConfig(validBase({ placement: "smart" as never })).errors.join(" ")).toContain("placement must be an object");
        });

        it("accepts a well-formed assets block and flags a missing directory, wrong shape, or non-string binding", () => {
            expect.assertions(4);

            expect(validateWranglerConfig(validBase({ assets: { binding: "ASSETS", directory: "./dist/client" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ assets: { binding: "ASSETS" } })).errors.join(" ")).toContain('must declare a non-empty "directory"');
            expect(validateWranglerConfig(validBase({ assets: "x" as never })).errors.join(" ")).toContain("assets must be an object");
            expect(validateWranglerConfig(validBase({ assets: { binding: 5 as never, directory: "./dist/client" } })).errors.join(" ")).toContain(
                "assets.binding must be a non-empty string",
            );
        });

        it("accepts a well-formed cache block and rejects bad shapes", () => {
            expect.assertions(5);

            expect(validateWranglerConfig(validBase({ cache: { enabled: true }, compatibility_date: "2026-05-01" })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ cache: { enabled: false } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ cache: "yes" as never })).errors.join(" ")).toContain("cache must be an object");
            expect(validateWranglerConfig(validBase({ cache: null })).errors.join(" ")).toContain("cache must be an object");
            expect(validateWranglerConfig(validBase({ cache: { enabled: "yes" as never } })).errors.join(" ")).toContain("cache.enabled must be a boolean");
        });

        it("requires compatibility_date >= 2026-05-01 when cache.enabled is true", () => {
            expect.assertions(7);

            const withCache = { cache: { enabled: true }, compatibility_date: "2026-05-01" };
            const withCacheOld = { cache: { enabled: true }, compatibility_date: "2026-04-07" };
            const withoutCache = { compatibility_date: "2026-04-07" };
            const exportsCacheOld = { exports: { default: { type: "worker", cache: { enabled: true } } }, compatibility_date: "2026-04-07" };
            const cacheWithMalformedDate = { cache: { enabled: true }, compatibility_date: "2026-4-7" };
            const nullExportsCache = { exports: null, cache: { enabled: true }, compatibility_date: "2026-04-07" };

            expect(validateWranglerConfig(validBase(withCache)).valid).toBe(true);
            expect(validateWranglerConfig(validBase(withCacheOld)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');
            expect(validateWranglerConfig(validBase(withoutCache)).valid).toBe(true);
            expect(validateWranglerConfig(validBase(exportsCacheOld)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');

            const malformedReport = validateWranglerConfig(validBase(cacheWithMalformedDate));

            expect(malformedReport.errors.join(" ")).toContain("YYYY-MM-DD");
            expect(malformedReport.errors.join(" ")).not.toContain('cache.enabled requires compatibility_date >= "2026-05-01"');

            // `exports: null` should not crash and should still surface the top-level cache date error.
            expect(validateWranglerConfig(validBase(nullExportsCache)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');
        });

        it("accepts a well-formed exports block and rejects malformed entry shapes", () => {
            expect.assertions(8);

            expect(
                validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: { enabled: true } } }, compatibility_date: "2026-05-01" }))
                    .valid,
            ).toBe(true);
            expect(validateWranglerConfig(validBase({ exports: { CachedBackend: { type: "worker", cache: { enabled: false } } } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ exports: "bad" as never })).errors.join(" ")).toContain("exports must be an object");
            expect(validateWranglerConfig(validBase({ exports: null })).errors.join(" ")).toContain("exports must be an object");
            expect(validateWranglerConfig(validBase({ exports: { default: "bad" as never } })).errors.join(" ")).toContain(
                'exports["default"] must be an object',
            );
            expect(validateWranglerConfig(validBase({ exports: { default: null } })).errors.join(" ")).toContain('exports["default"] must be an object');
            expect(validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: { enabled: 1 as never } } } })).errors.join(" ")).toContain(
                'exports["default"].cache.enabled must be a boolean',
            );
            expect(validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: null } } })).errors.join(" ")).toContain(
                'exports["default"].cache must be an object',
            );
        });
    });
});
