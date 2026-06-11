import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { injectRemoteFlags, isRemoteEnvEnabled, materializeRemoteWranglerConfig, planRemoteBindings } from "../src/remote-bindings";

// A config covering all three eligible kinds plus a Durable Object (which must
// never be remoted) and a comment that must survive the jsonc edits.
const FULL_WRANGLER = `{
    // a hand-written comment that must survive remote-flag injection
    "name": "cirrus-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "abc" }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "kv1" }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "app-files" }],
}
`;

const readJsonc = (text: string): Record<string, any> => parseJsonc(text) as Record<string, any>;

describe("planRemoteBindings", () => {
    it("selects every D1/KV/R2 binding and never a Durable Object", () => {
        expect.assertions(3);

        const parsed = readJsonc(FULL_WRANGLER);
        const plans = planRemoteBindings(parsed);

        expect(plans.map((plan) => plan.binding).toSorted((a, b) => a.localeCompare(b))).toEqual(["CACHE", "DB", "FILES"]);
        expect(plans.map((plan) => plan.kind).toSorted((a, b) => a.localeCompare(b))).toEqual(["D1", "KV", "R2"]);
        // No plan references the durable_objects section.
        expect(plans.some((plan) => (plan.section as string) === "durable_objects")).toBe(false);
    });

    it("returns an empty plan when no eligible bindings exist", () => {
        expect.assertions(1);

        const plans = planRemoteBindings({});

        expect(plans).toEqual([]);
    });

    it("skips null entries but keeps a stable index for the surviving ones", () => {
        expect.assertions(2);

        const plans = planRemoteBindings({
            d1_databases: [null, { binding: "DB" }],
        });

        expect(plans).toHaveLength(1);
        // The surviving entry keeps its real array index (1), so the edit path
        // targets the right element.
        expect(plans[0]).toMatchObject({ binding: "DB", index: 1, kind: "D1" });
    });

    it("labels a binding with no name by its index so logging stays meaningful", () => {
        expect.assertions(1);

        const plans = planRemoteBindings({ kv_namespaces: [{}] });

        expect(plans[0]?.binding).toBe("#0");
    });
});

describe("injectRemoteFlags", () => {
    it("adds remote:true to each planned binding and preserves comments", () => {
        expect.assertions(5);

        const plans = planRemoteBindings(readJsonc(FULL_WRANGLER));
        const next = injectRemoteFlags(FULL_WRANGLER, plans);

        expect(next).toContain("a hand-written comment that must survive");

        const config = readJsonc(next);

        expect(config.d1_databases[0].remote).toBe(true);
        expect(config.kv_namespaces[0].remote).toBe(true);
        expect(config.r2_buckets[0].remote).toBe(true);
        // The Durable Object binding is untouched — no remote flag leaks onto it.
        expect(config.durable_objects.bindings[0].remote).toBeUndefined();
    });

    it("is a no-op for an empty plan", () => {
        expect.assertions(1);

        expect(injectRemoteFlags(FULL_WRANGLER, [])).toBe(FULL_WRANGLER);
    });
});

describe("isRemoteEnvEnabled", () => {
    it.each([
        ["1", true],
        ["true", true],
        ["TRUE", true],
        [" true ", true],
        ["0", false],
        ["false", false],
        ["", false],
        ["yes", false],
        [undefined, false],
    ])("parses %j as %j", (value, expected) => {
        expect.assertions(1);

        expect(isRemoteEnvEnabled(value)).toBe(expected);
    });
});

describe("materializeRemoteWranglerConfig", () => {
    let root: string;
    let generated: string | undefined;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "cirrus-remote-test-"));
        generated = undefined;
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });

        if (generated) {
            rmSync(join(generated, ".."), { force: true, recursive: true });
        }
    });

    it("is a no-op when disabled", () => {
        expect.assertions(3);

        const result = materializeRemoteWranglerConfig({ enabled: false, projectRoot: root });

        expect(result.enabled).toBe(false);
        expect(result.configPath).toBeUndefined();
        expect(result.remoteBindings).toEqual([]);
    });

    it("writes a temp config with remote flags when enabled", () => {
        expect.assertions(5);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeRemoteWranglerConfig({ enabled: true, projectRoot: root });

        generated = result.configPath;

        expect(result.enabled).toBe(true);
        expect(result.configPath).toBeDefined();
        expect(result.remoteBindings.map((binding) => binding.binding).toSorted((a, b) => a.localeCompare(b))).toEqual(["CACHE", "DB", "FILES"]);

        const written = readJsonc(readFileSync(result.configPath as string, "utf8"));

        expect(written.d1_databases[0].remote).toBe(true);
        // The user's source config is never mutated.
        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(FULL_WRANGLER);
    });

    it("reports a reason and no config path when no wrangler file exists", () => {
        expect.assertions(2);

        const result = materializeRemoteWranglerConfig({ enabled: true, projectRoot: root });

        expect(result.configPath).toBeUndefined();
        expect(result.reason).toContain("not found");
    });

    it("reports a reason when the config declares no eligible bindings", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{ "name": "x", "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] } }`,
            "utf8",
        );

        const result = materializeRemoteWranglerConfig({ enabled: true, projectRoot: root });

        expect(result.configPath).toBeUndefined();
        expect(result.reason).toContain("no D1/KV/R2");
    });

    it("reports a parse failure for malformed JSONC", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{ this is : not json `, "utf8");

        const result = materializeRemoteWranglerConfig({ enabled: true, projectRoot: root });

        expect(result.configPath).toBeUndefined();
        expect(result.reason).toContain("parse");
    });
});
