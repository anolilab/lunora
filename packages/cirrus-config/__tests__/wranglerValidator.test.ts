import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { WranglerConfig } from "../src/wranglerValidator.js";
import {
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWrangler,
    validateWranglerConfig,
    validateWranglerProject,
} from "../src/wranglerValidator.js";

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

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-config-wrangler-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("validateWranglerConfig (pure)", () => {
    test("returns valid:true when all required bindings/flags are present", () => {
        const wrangler: WranglerConfig = {
            compatibility_date: REQUIRED_COMPATIBILITY_DATE,
            compatibility_flags: [REQUIRED_FLAG],
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        };

        const report = validateWranglerConfig(wrangler);

        expect(report.valid).toBe(true);
        expect(report.errors).toEqual([]);
    });

    test("reports the SHARD binding when missing", () => {
        const report = validateWranglerConfig({
            compatibility_date: REQUIRED_COMPATIBILITY_DATE,
            compatibility_flags: [REQUIRED_FLAG],
        });

        expect(report.valid).toBe(false);
        expect(report.errors.some((line) => /SHARD.+ShardDO/u.test(line))).toBe(true);
    });

    test("does not require the compatibility flag when compatibility_date is recent enough", () => {
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

    test("reports an outdated compatibility_date", () => {
        const report = validateWranglerConfig({
            compatibility_date: "2024-01-01",
            compatibility_flags: [REQUIRED_FLAG],
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        });

        expect(report.errors.some((line) => line.includes("compatibility_date"))).toBe(true);
    });

    test("requires a DB binding when the schema has any .global() table", () => {
        const wrangler: WranglerConfig = {
            compatibility_date: REQUIRED_COMPATIBILITY_DATE,
            compatibility_flags: [REQUIRED_FLAG],
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        };

        const report = validateWranglerConfig(wrangler, { hasGlobalTable: true });

        expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
    });

    test("validateWrangler is an alias for validateWranglerConfig", () => {
        expect(validateWrangler).toBe(validateWranglerConfig);
    });

    test("treats a non-object wrangler as invalid", () => {
        const report = validateWranglerConfig(undefined);

        expect(report.valid).toBe(false);
        expect(report.errors.length).toBeGreaterThan(0);
    });
});

describe("validateWranglerProject (file-system aware)", () => {
    test("passes when wrangler.jsonc declares everything the schema implies", () => {
        writeSchema(SCHEMA_WITH_GLOBAL);
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

        const result = validateWranglerProject({ projectRoot: workdir });

        expect(result.problems).toEqual([]);
        expect(result.report.valid).toBe(true);
        expect(result.wranglerPath).toBe(join(workdir, "wrangler.jsonc"));
    });

    test("returns a problem when wrangler.jsonc is missing entirely", () => {
        writeSchema(SCHEMA_NO_GLOBAL);

        const result = validateWranglerProject({ projectRoot: workdir });

        expect(result.problems.join("\n")).toMatch(/wrangler\.jsonc not found/u);
        expect(result.wranglerPath).toBeUndefined();
    });

    test("does not require D1 when no table is global", () => {
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

    test("supports jsonc comments and trailing commas", () => {
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

    test("returns a problem when SHARD durable-object binding is missing", () => {
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

        expect(result.problems.some((line) => /SHARD.+ShardDO/u.test(line))).toBe(true);
    });

    test("returns a problem when schema has .global() tables but D1 binding is missing", () => {
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
