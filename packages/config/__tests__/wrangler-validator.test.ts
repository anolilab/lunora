import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WranglerConfig } from "../src/wrangler-validator.js";
import {
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWrangler,
    validateWranglerConfig,
    validateWranglerProject,
    withTailConsumer,
} from "../src/wrangler-validator.js";

const SHARD_BINDING_ERROR_RE = /SHARD.+ShardDO/u;
const WRANGLER_NOT_FOUND_RE = /wrangler\.jsonc not found/u;

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

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

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const SCHEMA_WITH_VECTOR = `import { defineSchema, defineTable, v } from "@cirrus/server";
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
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["nodejs_compat", "${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "cirrus-global", "database_id": "x" }]
}
`;

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "cirrus"), { recursive: true });
    writeFileSync(join(workdir, "cirrus", "schema.ts"), source, "utf8");
};

describe("wrangler-validator", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-config-wrangler-"));
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
    });
});
