import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    injectRemoteFlags,
    isRemoteEnvEnabled,
    materializeDevWranglerConfig,
    planRemoteBindings,
    REMOTE_ELIGIBLE_KEYS,
    resolveRemoteEnabled,
} from "../src/cloudflare/remote-bindings";

// A config covering every eligible kind (D1/KV/R2 arrays, Vectorize/Services
// arrays, a queue *producer*, and the single AI object) plus the shapes that
// must NEVER be remoted (a Durable Object + a queue *consumer*) and a comment
// that must survive the jsonc edits.
const FULL_WRANGLER = `{
    // a hand-written comment that must survive remote-flag injection
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "abc" }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "kv1" }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "app-files" }],
    "vectorize": [{ "binding": "SEARCH", "index_name": "docs" }],
    "services": [{ "binding": "AUTH", "service": "auth-worker" }],
    "ai": { "binding": "AI" },
    "queues": {
        "producers": [{ "binding": "JOBS", "queue": "jobs" }],
        "consumers": [{ "queue": "jobs", "max_batch_size": 10 }],
    },
}
`;

const readJsonc = (text: string): Record<string, any> => parseJsonc(text) as Record<string, any>;

describe("planRemoteBindings", () => {
    it("selects every eligible kind (D1/KV/R2/Vectorize/Service/AI/Queue-producer) and never a Durable Object", () => {
        expect.assertions(3);

        const parsed = readJsonc(FULL_WRANGLER);
        const plans = planRemoteBindings(parsed);

        expect(plans.map((plan) => plan.binding).toSorted((a, b) => a.localeCompare(b))).toEqual(["AI", "AUTH", "CACHE", "DB", "FILES", "JOBS", "SEARCH"]);
        expect(plans.map((plan) => plan.kind).toSorted((a, b) => a.localeCompare(b))).toEqual(["AI", "D1", "KV", "Queue", "R2", "Service", "Vectorize"]);
        // No plan references the durable_objects section.
        expect(plans.some((plan) => (plan.section as string) === "durable_objects")).toBe(false);
    });

    it("remotes a queue producer via a two-level path and never a consumer", () => {
        expect.assertions(3);

        // Consumers carry no `binding`/`remote` field, so the shape only exposes
        // producers; the planner reads `binding` and ignores everything else.
        const plans = planRemoteBindings({
            queues: { producers: [{ binding: "JOBS" }] },
        });

        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ binding: "JOBS", kind: "Queue", section: "queues" });
        // Path is relative to the `queues` section: producers array, index 0.
        expect(plans[0]?.path).toEqual(["producers", 0]);
    });

    it("remotes the single AI binding with an empty (section-level) path", () => {
        expect.assertions(2);

        const plans = planRemoteBindings({ ai: { binding: "AI" } });

        expect(plans[0]).toMatchObject({ binding: "AI", kind: "AI", section: "ai" });
        expect(plans[0]?.path).toEqual([]);
    });

    it("remotes the single Analytics SQL binding with a section-level path", () => {
        expect.assertions(2);

        const plans = planRemoteBindings({ analytics: { binding: "ANALYTICS_SQL" } });

        expect(plans).toStrictEqual([{ binding: "ANALYTICS_SQL", kind: "Analytics SQL", path: [], section: "analytics" }]);
        expect(readJsonc(injectRemoteFlags(`{ "analytics": { "binding": "ANALYTICS_SQL" } }`, plans)).analytics).toStrictEqual({
            binding: "ANALYTICS_SQL",
            remote: true,
        });
    });

    it("remotes both AI Search sections by array index", () => {
        expect.assertions(2);

        const plans = planRemoteBindings({
            ai_search: [{ binding: "BLOG_SEARCH" }],
            ai_search_namespaces: [{ binding: "AI_SEARCH" }],
        });

        expect(plans).toStrictEqual([
            { binding: "BLOG_SEARCH", kind: "AI Search", path: [0], section: "ai_search" },
            { binding: "AI_SEARCH", kind: "AI Search namespace", path: [0], section: "ai_search_namespaces" },
        ]);
        expect(
            readJsonc(injectRemoteFlags(`{ "ai_search_namespaces": [{ "binding": "AI_SEARCH", "namespace": "default" }] }`, plans.slice(1)))
                .ai_search_namespaces,
        ).toStrictEqual([{ binding: "AI_SEARCH", namespace: "default", remote: true }]);
    });

    it("never lists durable_objects, queue consumers, or other remote-ineligible kinds", () => {
        expect.assertions(1);

        // `durable_objects` is intentionally excluded — shards stay local.
        expect((REMOTE_ELIGIBLE_KEYS as Record<string, unknown>).durable_objects).toBeUndefined();
    });

    it("returns an empty plan when no eligible bindings exist", () => {
        expect.assertions(1);

        const plans = planRemoteBindings({});

        expect(plans).toEqual([]);
    });

    it("skips null entries but keeps a stable index path for the surviving ones", () => {
        expect.assertions(2);

        const plans = planRemoteBindings({
            d1_databases: [null, { binding: "DB" }],
        });

        expect(plans).toHaveLength(1);
        // The surviving entry keeps its real array index (1) in its edit path, so
        // the injection targets the right element.
        expect(plans[0]).toMatchObject({ binding: "DB", kind: "D1", path: [1] });
    });

    it("labels a binding with no name by its index so logging stays meaningful", () => {
        expect.assertions(1);

        const plans = planRemoteBindings({ kv_namespaces: [{}] });

        expect(plans[0]?.binding).toBe("#0");
    });
});

describe("injectRemoteFlags", () => {
    it("adds remote:true to each planned binding (every kind) and preserves comments", () => {
        expect.assertions(10);

        const plans = planRemoteBindings(readJsonc(FULL_WRANGLER));
        const next = injectRemoteFlags(FULL_WRANGLER, plans);

        expect(next).toContain("a hand-written comment that must survive");

        const config = readJsonc(next);

        expect(config.d1_databases[0].remote).toBe(true);
        expect(config.kv_namespaces[0].remote).toBe(true);
        expect(config.r2_buckets[0].remote).toBe(true);
        expect(config.vectorize[0].remote).toBe(true);
        expect(config.services[0].remote).toBe(true);
        // The single AI object and the queue *producer* are flipped via their
        // section-level / two-level edit paths.
        expect(config.ai.remote).toBe(true);
        expect(config.queues.producers[0].remote).toBe(true);
        // The queue *consumer* and the Durable Object binding are untouched —
        // no remote flag leaks onto either.
        expect(config.queues.consumers[0].remote).toBeUndefined();
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

describe("materializeDevWranglerConfig with remote off", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-local-test-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("writes a copy without the AI binding when there is no Cloudflare login", () => {
        expect.assertions(6);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ remote: false, hasCredentials: () => false, projectRoot: root });

        expect(result.withheld).toStrictEqual(["AI"]);
        expect(result.configPath).toBeDefined();

        const text = readFileSync(result.configPath!, "utf8");

        expect(readJsonc(text).ai).toBeUndefined();
        // Everything else survives, comments included.
        expect(readJsonc(text).d1_databases).toStrictEqual([{ binding: "DB", database_id: "abc", database_name: "app" }]);
        expect(text).toContain("a hand-written comment");

        result.cleanup();

        expect(existsSync(result.configPath!)).toBe(false);
    });

    it("leaves the user's config alone when wrangler is logged in", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ remote: false, hasCredentials: () => true, projectRoot: root });

        expect(result.configPath).toBeUndefined();
        expect(result.withheld).toStrictEqual([]);
    });

    it("never probes credentials for a config without an AI binding", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/index.ts" }`, "utf8");

        let probed = false;
        const result = materializeDevWranglerConfig({
            remote: false,
            hasCredentials: () => {
                probed = true;

                return false;
            },
            projectRoot: root,
        });

        expect(result.configPath).toBeUndefined();
        expect(probed).toBe(false);
    });
});

describe("materializeDevWranglerConfig with remote on", () => {
    let root: string;
    let generated: string | undefined;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-remote-test-"));
        generated = undefined;
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });

        if (generated) {
            rmSync(join(generated, ".."), { force: true, recursive: true });
        }
    });

    it("is a no-op when remote is off and nothing needs withholding, with a safe cleanup", () => {
        expect.assertions(3);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: false });

        expect(result.configPath).toBeUndefined();
        expect(result.remoteBindings).toEqual([]);
        // A disposer is always present and a harmless no-op when nothing was written.
        expect(() => {
            result.cleanup();
        }).not.toThrow();
    });

    it("writes a temp config with remote flags for every kind when remote is on", () => {
        expect.assertions(4);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        generated = result.configPath;

        expect(result.configPath).toBeDefined();
        expect(result.remoteBindings.map((binding) => binding.binding).toSorted((a, b) => a.localeCompare(b))).toEqual([
            "AI",
            "AUTH",
            "CACHE",
            "DB",
            "FILES",
            "JOBS",
            "SEARCH",
        ]);

        const written = readJsonc(readFileSync(result.configPath as string, "utf8"));

        expect(written.vectorize[0].remote).toBe(true);
        // The user's source config is never mutated.
        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(FULL_WRANGLER);
    });

    it("keeps a Lunora-owned service binding local and remotes a hand-written one", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{ "services": [{ "binding": "SERVICE_PARSER", "service": "parser" }, { "binding": "LEGACY", "service": "legacy" }] }`,
            "utf8",
        );
        writeFileSync(join(root, "package.json"), `{ "lunora": { "services": { "services": ["SERVICE_PARSER"] } } }`, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        generated = result.configPath;

        expect(result.remoteBindings.map((binding) => binding.binding)).toStrictEqual(["LEGACY"]);
    });

    it("writes the temp config as a SIBLING of wrangler.jsonc (not an OS temp dir)", () => {
        // Regression: wrangler resolves a config's relative `main`/`assets` paths
        // against the CONFIG FILE's own directory. A temp config in `/tmp` would
        // make wrangler look for `/tmp/src/server.ts` and fail to start. The
        // generated config must therefore live beside the source wrangler.jsonc.
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        generated = result.configPath;

        // Lives directly in the project root (same dir as wrangler.jsonc), so a
        // relative `main: "src/server.ts"` still resolves — not in a subdirectory.
        expect(dirname(result.configPath as string)).toBe(root);
        expect(existsSync(result.configPath as string)).toBe(true);
    });

    it("returns a cleanup that removes the temp config and is idempotent", () => {
        expect.assertions(3);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        expect(existsSync(result.configPath as string)).toBe(true);

        result.cleanup();

        expect(existsSync(result.configPath as string)).toBe(false);
        // Calling it again (idempotent) must not throw even though it's gone.
        expect(() => {
            result.cleanup();
        }).not.toThrow();
    });

    it("gives each materialization its own path, so an older disposer cannot delete the newer config", () => {
        expect.assertions(3);

        // Regression: the temp path was constant within a dev process, and Vite's
        // `restartServer` resolves the NEW config (materializing a fresh file)
        // BEFORE closing the old server — so the old generation's disposer ran
        // last and deleted the file the new generation had just written, leaving
        // the worker on empty local D1/KV/R2.
        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const first = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });
        const second = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        generated = second.configPath;

        expect(first.configPath).not.toBe(second.configPath);

        first.cleanup();

        expect(existsSync(first.configPath as string)).toBe(false);
        expect(existsSync(second.configPath as string)).toBe(true);
    });

    it("reports a reason and no config path when no wrangler file exists", () => {
        expect.assertions(2);

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

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

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        expect(result.configPath).toBeUndefined();
        expect(result.reason).toContain("no remote-eligible bindings");
    });

    it("reports a parse failure for malformed JSONC", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), `{ this is : not json `, "utf8");

        const result = materializeDevWranglerConfig({ hasCredentials: () => true, projectRoot: root, remote: true });

        expect(result.configPath).toBeUndefined();
        expect(result.reason).toContain("parse");
    });
});

describe("resolveRemoteEnabled", () => {
    it("returns true when the explicit --remote flag is set, regardless of env/config", () => {
        expect.assertions(1);

        expect(resolveRemoteEnabled({ configPreference: false, envValue: "0", flag: true })).toBe(true);
    });

    it("returns true when LUNORA_REMOTE is truthy and the flag is absent", () => {
        expect.assertions(1);

        expect(resolveRemoteEnabled({ configPreference: false, envValue: "1" })).toBe(true);
    });

    it("falls back to the lunora.config.* preference when neither flag nor env is set", () => {
        expect.assertions(2);

        expect(resolveRemoteEnabled({ configPreference: true })).toBe(true);
        expect(resolveRemoteEnabled({ configPreference: false })).toBe(false);
    });

    it("is off by default when nothing opts in", () => {
        expect.assertions(1);

        expect(resolveRemoteEnabled({})).toBe(false);
    });

    it("lets --remote and LUNORA_REMOTE override a lunora.config.* `remote: false`", () => {
        expect.assertions(2);

        expect(resolveRemoteEnabled({ configPreference: false, flag: true })).toBe(true);
        expect(resolveRemoteEnabled({ configPreference: false, envValue: "true" })).toBe(true);
    });
});

describe("remote mode without Cloudflare credentials", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-remote-logout-test-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("keeps the other remote bindings and withholds only the ai binding", () => {
        expect.assertions(5);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ remote: true, hasCredentials: () => false, projectRoot: root });

        expect(result.withheld).toStrictEqual(["AI"]);
        expect(result.remoteBindings.map((plan) => plan.binding)).not.toContain("AI");
        expect(result.configPath).toBeDefined();

        const text = readFileSync(result.configPath!, "utf8");

        expect(readJsonc(text).ai).toBeUndefined();
        expect(readJsonc(text).d1_databases).toStrictEqual([{ binding: "DB", database_name: "app", database_id: "abc", remote: true }]);

        result.cleanup();
    });

    it("writes a config without ai even when ai is the only remote binding", () => {
        expect.assertions(3);

        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "src/index.ts", "ai": { "binding": "AI" } }`, "utf8");

        const result = materializeDevWranglerConfig({ remote: true, hasCredentials: () => false, projectRoot: root });

        expect(result.remoteBindings).toStrictEqual([]);
        expect(result.configPath).toBeDefined();
        expect(readJsonc(readFileSync(result.configPath!, "utf8")).ai).toBeUndefined();

        result.cleanup();
    });

    it("keeps the ai binding remote when logged in", () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), FULL_WRANGLER, "utf8");

        const result = materializeDevWranglerConfig({ remote: true, hasCredentials: () => true, projectRoot: root });

        expect(result.withheld).toStrictEqual([]);
        expect(result.remoteBindings.map((plan) => plan.binding)).toContain("AI");

        result.cleanup();
    });
});
