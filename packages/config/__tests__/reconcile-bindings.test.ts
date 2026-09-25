import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerBindings } from "../src/cloudflare/reconcile-bindings";
import type { DurableObjectSpec, InferredBindings } from "../src/infer-bindings";

const SHARD: DurableObjectSpec = { binding: "SHARD", className: "ShardDO" };
const SCHEDULER: DurableObjectSpec = { binding: "SCHEDULER", className: "SchedulerDO" };
const SESSION: DurableObjectSpec = { binding: "SESSION", className: "SessionDO" };

const baseInferred = (overrides: Partial<InferredBindings> = {}): InferredBindings => {
    return {
        agents: [],
        containers: [],
        durableObjects: [SHARD],
        needsD1: false,
        queues: [],
        signals: [],
        usesAi: false,
        usesAnalytics: false,
        usesAuth: false,
        usesBrowser: false,
        usesHyperdrive: false,
        usesFlags: false,
        usesImages: false,
        usesKv: false,
        usesMail: false,
        usesNotify: false,
        usesPayment: false,
        usesPipelines: false,
        usesR2sql: false,
        usesScheduler: false,
        usesStorage: false,
        usesX402Charge: false,
        usesX402Pay: false,
        workflows: [],
        ...overrides,
    };
};

const MINIMAL_WRANGLER = `{
    // a hand-written comment that must survive reconciliation
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    // A fully-synced config carries observability (reconcile turns it on when
    // absent), so the no-op tests below start from a config that already has it.
    "observability": { "enabled": true },
}
`;

describe("reconcileWranglerBindings", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-reconcile-"));
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

    describe("environment argument (advisory only — does not change WHERE bindings are written)", () => {
        it("still writes only to the top level when environment is passed", () => {
            expect.assertions(2);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [] },
    "env": { "production": {} },
}
`,
                "utf8",
            );

            const result = reconcileWranglerBindings(root, baseInferred(), "production");

            expect(result.changed).toBe(true);
            // The write landed at the top level, not inside env.production —
            // the pipeline has no env-scoped write path (see the doc comment).
            expect(readConfig().durable_objects.bindings).toContainEqual({ class_name: "ShardDO", name: "SHARD" });
        });

        it("warns that env.production has its own non-inheritable bindings needing manual reconciliation", () => {
            expect.assertions(1);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [] },
    "env": { "production": {} },
}
`,
                "utf8",
            );

            const result = reconcileWranglerBindings(root, baseInferred(), "production");

            expect(result.warnings.some((line) => line.includes("env.production") && line.includes("top level"))).toBe(true);
        });

        it("warns distinctly when the requested environment isn't declared at all", () => {
            expect.assertions(1);

            const result = reconcileWranglerBindings(root, baseInferred(), "production");

            expect(result.warnings.some((line) => line.includes('no "env.production" block'))).toBe(true);
        });

        it("does not warn about environments when none was requested (unchanged default)", () => {
            expect.assertions(1);

            const result = reconcileWranglerBindings(root, baseInferred());

            expect(result.warnings.some((line) => line.includes("env."))).toBe(false);
        });
    });

    it("turns on observability when the key is absent (not just for container apps)", () => {
        expect.assertions(3);

        // A plain Worker+DO config with no observability key — reconcile should
        // enable Workers Logs + Traces by default.
        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred());

        expect(result.changed).toBe(true);
        expect(result.added).toContain("observability");
        expect(readConfig().observability).toEqual({ enabled: true, head_sampling_rate: 1 });
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

    it("treats a class introduced by renamed_classes as already registered", () => {
        expect.assertions(2);

        // wrangler's own `getDeclaredDOClassNames` applies deleted_classes and
        // renamed_classes alongside the new_* lists. Appending a second
        // `new_sqlite_classes: ["ShardDO"]` here makes miniflare throw
        // "Cannot apply new_sqlite_classes migration to existing class ShardDO",
        // and the write persists in the committed config.
        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "observability": { "enabled": true, "head_sampling_rate": 1 },
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["OldShardDO"] },
        { "tag": "v2", "renamed_classes": [{ "from": "OldShardDO", "to": "ShardDO" }] }
    ],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred());

        expect(result.changed).toBe(false);
        expect(readConfig().migrations).toHaveLength(2);
    });

    it("re-registers a class a later deleted_classes migration removed", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "observability": { "enabled": true, "head_sampling_rate": 1 },
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["ShardDO"] },
        { "tag": "v2", "deleted_classes": ["ShardDO"] }
    ],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred());

        expect(result.changed).toBe(true);
        expect(readConfig().migrations.at(-1)).toEqual({ new_sqlite_classes: ["ShardDO"], tag: "v3" });
    });

    // `wrangler.jsonc` is hand-edited, so a stray `null` (a trailing comma in a
    // JSONC array parses to one) reaches the replay. Reconcile must still return
    // a report — the malformed shape is the validator's error to describe, not a
    // raw TypeError out of a provisioning step that runs on every dev start.
    it("reconciles past null entries in migrations, renamed_classes and the class lists", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "observability": { "enabled": true, "head_sampling_rate": 1 },
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [
        null,
        { "tag": "v1", "new_sqlite_classes": ["OldShardDO", null] },
        { "tag": "v2", "renamed_classes": [null, { "from": "OldShardDO", "to": "ShardDO" }] },
        { "tag": "v3", "deleted_classes": [null] }
    ],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred());

        // `ShardDO` IS declared (by the rename), so nothing is appended — the
        // null entries must not hide that and trigger a duplicate migration.
        expect(result.changed).toBe(false);
        expect(readConfig().migrations).toHaveLength(4);
    });

    it("adds the DB binding when a global schema is inferred, and warns about the placeholder id", () => {
        expect.assertions(3);

        const result = reconcileWranglerBindings(root, baseInferred({ needsD1: true }));

        expect(result.added).toContain("DB (D1)");
        expect(readConfig().d1_databases[0].binding).toBe("DB");
        expect(result.warnings.join(" ")).toMatch(/placeholder database_id/u);
    });

    it("adds the parameterless ai binding when @lunora/ai is inferred", () => {
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
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "observability": { "enabled": true },
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
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "observability": { "enabled": true },
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

    it("warns rather than guesses when @lunora/storage is used", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesStorage: true }));

        expect(result.warnings.join(" ")).toMatch(/r2_buckets/u);
        expect(readConfig().r2_buckets).toBeUndefined();
    });

    it("keeps warning about pipelines until the binding codegen resolves actually exists", () => {
        expect.assertions(3);

        // Codegen resolves ONE fixed name — `config.pipelines?.(env) ?? env.PIPELINES`
        // — and `pipelines` has no `defineApp` override, so a differently-named
        // entry satisfies the wrangler validator while `ctx.pipelines.send()`
        // still throws at runtime. Keying the hint on array length silenced it
        // for exactly that config, and nothing before runtime ever named
        // PIPELINES.
        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "pipelines": [{ "binding": "EVENTS", "pipeline": "events" }],
}
`,
            "utf8",
        );

        const wrongName = reconcileWranglerBindings(root, baseInferred({ usesPipelines: true }));

        expect(wrongName.warnings.join(" ")).toMatch(/PIPELINES/u);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "pipelines": [{ "binding": "PIPELINES", "pipeline": "events" }],
}
`,
            "utf8",
        );

        expect(reconcileWranglerBindings(root, baseInferred({ usesPipelines: true })).warnings.join(" ")).not.toMatch(/pipelines binding/u);
        // The pipeline resource is un-mintable, so nothing is auto-written either way.
        expect(readConfig().pipelines).toStrictEqual([{ binding: "PIPELINES", pipeline: "events" }]);
    });

    it("warns when Flagship binding mode is used but no flagship binding exists, without writing one", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ flagshipBinding: "FLAGS", usesFlags: true }));

        expect(result.warnings.join(" ")).toMatch(/flagship binding "FLAGS".*app_id/u);
        // The app_id is un-mintable, so nothing is auto-written.
        expect(readConfig().flagship).toBeUndefined();
    });

    it("does not warn about flagship when a matching flagship binding already exists", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "flagship": [{ "binding": "FLAGS", "app_id": "app-abc" }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ flagshipBinding: "FLAGS", usesFlags: true }));

        expect(result.warnings.join(" ")).not.toMatch(/flagship binding/u);
    });

    it("does not warn about flagship for an HTTP-mode provider (no binding implied)", () => {
        expect.assertions(1);

        const result = reconcileWranglerBindings(root, baseInferred({ usesFlags: true }));

        expect(result.warnings.join(" ")).not.toMatch(/flagship binding/u);
    });

    it("warns to set the provider secrets when @lunora/payment is used, without adding any binding", () => {
        expect.assertions(3);

        const result = reconcileWranglerBindings(root, baseInferred({ usesPayment: true }));

        expect(result.warnings.join(" ")).toMatch(/STRIPE_SECRET_KEY.*POLAR_ACCESS_TOKEN/u);
        // Payment rides the existing ShardDO via ctx.db — no new binding written.
        expect(result.changed).toBe(false);
        expect(readConfig().durable_objects.bindings.map((binding: { name: string }) => binding.name)).toEqual(["SHARD"]);
    });

    it("suppresses the payment reminder once any provider's secret pair is set in .dev.vars", () => {
        expect.assertions(2);

        // Creem, not Stripe — the reminder must clear for every supported adapter,
        // not just the two it used to name.
        const devVars = ["CREEM_API_KEY=set", "CREEM_WEBHOOK_SECRET=set", ""].join("\n");

        writeFileSync(join(root, ".dev.vars"), devVars);

        const result = reconcileWranglerBindings(root, baseInferred({ usesPayment: true }));

        expect(result.warnings.join(" ")).not.toMatch(/@lunora\/payment is used/u);
        expect(result.changed).toBe(false);
    });

    it("still reminds when .dev.vars declares a provider key with an empty value", () => {
        expect.assertions(1);

        // A scaffolded-but-unfilled pair is not configured.
        writeFileSync(join(root, ".dev.vars"), "CREEM_API_KEY=\nCREEM_WEBHOOK_SECRET=\n");

        const result = reconcileWranglerBindings(root, baseInferred({ usesPayment: true }));

        expect(result.warnings.join(" ")).toMatch(/@lunora\/payment is used/u);
    });

    it("reminds to add a recipient [vars] entry when @lunora/x402/charge is used, without writing a binding", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesX402Charge: true }));

        expect(result.warnings.join(" ")).toMatch(/x402\/charge.*recipient wallet address.*\[vars\]/u);
        // The recipient var name is user-chosen — nothing is auto-written.
        expect(result.changed).toBe(false);
    });

    it("reminds to add a Secrets Store binding + spend policy when @lunora/x402/pay is used, without writing a binding", () => {
        expect.assertions(3);

        const result = reconcileWranglerBindings(root, baseInferred({ usesX402Pay: true }));

        expect(result.warnings.join(" ")).toMatch(/x402\/pay.*secrets_store_secrets\[\].*spend policy/u);
        // ctx.secrets is a Secrets Store binding (created out-of-band), not a
        // .dev.vars value, so the pay wallet key is a hint — never auto-written.
        expect(result.warnings.join(" ")).toMatch(/Secrets Store binding, not \.dev\.vars/u);
        expect(result.changed).toBe(false);
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
    "name": "lunora-app",
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
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "observability": { "enabled": true },
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

    it("auto-writes the self-describing browser binding when @lunora/browser is inferred, idempotently", () => {
        expect.assertions(3);

        const first = reconcileWranglerBindings(root, baseInferred({ usesBrowser: true }));

        expect(first.added).toContain("BROWSER (Browser Rendering)");
        expect(readConfig().browser).toEqual({ binding: "BROWSER" });

        const second = reconcileWranglerBindings(root, baseInferred({ usesBrowser: true }));

        expect(second.changed).toBe(false);
    });

    it("auto-writes the self-describing analytics dataset when @lunora/bindings/analytics is inferred, idempotently", () => {
        expect.assertions(3);

        const first = reconcileWranglerBindings(root, baseInferred({ usesAnalytics: true }));

        expect(first.added).toContain("ANALYTICS (Analytics Engine)");
        expect(readConfig().analytics_engine_datasets).toEqual([{ binding: "ANALYTICS", dataset: "ANALYTICS" }]);

        const second = reconcileWranglerBindings(root, baseInferred({ usesAnalytics: true }));

        expect(second.changed).toBe(false);
    });

    it("warns rather than writes a kv_namespaces binding when @lunora/bindings/kv is used (the namespace id can't be minted)", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesKv: true }));

        expect(result.warnings.join(" ")).toMatch(/kv_namespaces/u);
        expect(readConfig().kv_namespaces).toBeUndefined();
    });

    it("does not warn about kv when a kv_namespaces binding already exists", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "abc123" }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ usesKv: true }));

        expect(result.warnings.join(" ")).not.toMatch(/kv_namespaces/u);
    });

    it("warns rather than writes a hyperdrive binding when @lunora/hyperdrive is used (the id can't be minted)", () => {
        expect.assertions(2);

        const result = reconcileWranglerBindings(root, baseInferred({ usesHyperdrive: true }));

        expect(result.warnings.join(" ")).toMatch(/hyperdrive/u);
        expect(readConfig().hyperdrive).toBeUndefined();
    });

    it("does not warn about hyperdrive when a hyperdrive binding already exists", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "hyperdrive": [{ "binding": "PG", "id": "real-hyperdrive-id" }],
}
`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, baseInferred({ usesHyperdrive: true }));

        expect(result.warnings.join(" ")).not.toMatch(/hyperdrive is used/u);
    });

    describe("voice agents", () => {
        // A voice-enabled agent: its durable loop still rides `workflows[]`, but
        // the real-time session is a Durable Object, so it ALSO needs a
        // `durable_objects` binding + `new_sqlite_classes` migration.
        const VOICE_SUPPORT = {
            bindingName: "AGENT_SUPPORT",
            className: "SupportAgentWorkflow",
            exported: true,
            exportName: "support",
            name: "agent-support",
            voice: true,
            voiceBindingName: "VOICE_SUPPORT",
            voiceClassName: "SupportVoiceDO",
        };

        it("provisions the voice DO binding + migration class for an exported voice agent", () => {
            expect.assertions(4);

            const result = reconcileWranglerBindings(root, baseInferred({ agents: [VOICE_SUPPORT] }));

            expect(result.changed).toBe(true);
            expect(result.added).toContain(`${VOICE_SUPPORT.voiceBindingName}/${VOICE_SUPPORT.voiceClassName}`);

            const config = readConfig();

            expect(config.durable_objects.bindings).toContainEqual({ class_name: "SupportVoiceDO", name: "VOICE_SUPPORT" });
            expect(config.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? [])).toContain("SupportVoiceDO");
        });

        it("is idempotent — a second run is a no-op", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ agents: [VOICE_SUPPORT] }));

            expect(reconcileWranglerBindings(root, baseInferred({ agents: [VOICE_SUPPORT] })).changed).toBe(false);
        });

        it("adds no voice DO for a non-voice agent (workflow-only path never touches durable_objects)", () => {
            expect.assertions(1);

            const result = reconcileWranglerBindings(
                root,
                baseInferred({ agents: [{ ...VOICE_SUPPORT, voice: false, voiceBindingName: undefined, voiceClassName: undefined }] }),
            );

            // The agent still reconciles into workflows[], but never a voice DO.
            expect(result.added.join(" ")).not.toContain("VoiceDO");
        });
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
            expect.assertions(4);

            const result = reconcileWranglerBindings(root, baseInferred({ containers: [{ ...TRANSCODER, exported: false }] }));

            expect(result.changed).toBe(false);
            expect(result.warnings.join(" ")).toContain("not exported by the worker entry");
            expect(readConfig().containers).toBeUndefined();
            // The structured gap (for the dev error overlay) mirrors the warning.
            expect(result.exportGaps).toStrictEqual([{ className: "TranscoderContainer", exportName: "transcoder", kind: "container", module: "containers" }]);
        });

        it("respects an explicit observability opt-out, with a warning", () => {
            expect.assertions(2);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                `{
    "name": "lunora-app",
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

        it("writes the deterministic build tag for a Railpack { build } source", () => {
            expect.assertions(2);

            const buildContainer = { ...TRANSCODER, image: { buildDir: "./services/transcoder", kind: "build" as const } };

            reconcileWranglerBindings(root, baseInferred({ containers: [buildContainer] }));

            const config = readConfig();

            expect(config.containers[0].image).toBe("lunora-transcoder:build");
            // A build source has no Dockerfile, so no image_build_context is written.
            expect(config.containers[0].image_build_context).toBeUndefined();
        });

        it("writes a registry image without a build context", () => {
            expect.assertions(1);

            const registryContainer = { ...TRANSCODER, image: { kind: "registry" as const, reference: "docker.io/acme/transcoder:1.4" } };

            reconcileWranglerBindings(root, baseInferred({ containers: [registryContainer] }));

            expect(readConfig().containers).toEqual([
                { class_name: "TranscoderContainer", image: "docker.io/acme/transcoder:1.4", instance_type: "standard-1", max_instances: 5 },
            ]);
        });

        it("writes image_vars and rollout fields with wrangler names", () => {
            expect.assertions(3);

            const richContainer = {
                ...TRANSCODER,
                buildArgs: { NODE_ENV: "production" },
                rollout: { gracePeriodSeconds: 300, stepPercentage: 25 },
            };

            reconcileWranglerBindings(root, baseInferred({ containers: [richContainer] }));

            const entry = readConfig().containers[0];

            expect(entry.image_vars).toEqual({ NODE_ENV: "production" });
            expect(entry.rollout_step_percentage).toBe(25);
            expect(entry.rollout_active_grace_period).toBe(300);
        });

        it("writes a custom instance type with wrangler field names", () => {
            expect.assertions(1);

            const customContainer = { ...TRANSCODER, instanceType: { memoryMib: 4096, vcpu: 1 } };

            reconcileWranglerBindings(root, baseInferred({ containers: [customContainer] }));

            expect(readConfig().containers[0].instance_type).toEqual({ memory_mib: 4096, vcpu: 1 });
        });
    });

    describe("workflows", () => {
        const ORDER_PIPELINE = {
            bindingName: "WORKFLOW_ORDER_PIPELINE",
            className: "OrderPipelineWorkflow",
            exported: true,
            exportName: "orderPipeline",
            name: "order-pipeline",
            steps: [],
        };

        it("provisions only the workflows[] entry — no DO binding, no migration class", () => {
            expect.assertions(5);

            const result = reconcileWranglerBindings(root, baseInferred({ workflows: [ORDER_PIPELINE] }));

            expect(result.changed).toBe(true);
            expect(result.added).toContain("workflows/OrderPipelineWorkflow");

            const config = readConfig();

            expect(config.workflows).toEqual([{ binding: "WORKFLOW_ORDER_PIPELINE", class_name: "OrderPipelineWorkflow", name: "order-pipeline" }]);
            // Workflows are not Durable Objects: never bound, never migrated.
            expect(config.durable_objects.bindings.map((binding: { name: string }) => binding.name)).not.toContain("WORKFLOW_ORDER_PIPELINE");
            expect(config.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? [])).not.toContain(
                "OrderPipelineWorkflow",
            );
        });

        it("is idempotent — a second run is a no-op", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ workflows: [ORDER_PIPELINE] }));

            const second = reconcileWranglerBindings(root, baseInferred({ workflows: [ORDER_PIPELINE] }));

            expect(second.changed).toBe(false);
        });

        it("skips an unexported workflow and warns instead", () => {
            expect.assertions(4);

            const result = reconcileWranglerBindings(root, baseInferred({ workflows: [{ ...ORDER_PIPELINE, exported: false }] }));

            expect(result.changed).toBe(false);
            expect(result.warnings.join(" ")).toContain("not exported by the worker entry");
            expect(readConfig().workflows).toBeUndefined();
            // The structured gap (for the dev error overlay) mirrors the warning.
            expect(result.exportGaps).toStrictEqual([
                { className: "OrderPipelineWorkflow", exportName: "orderPipeline", kind: "workflow", module: "workflows" },
            ]);
        });

        it("appends a new workflow alongside an existing one, matched by class_name", () => {
            expect.assertions(2);

            reconcileWranglerBindings(root, baseInferred({ workflows: [ORDER_PIPELINE] }));

            const SECOND = {
                bindingName: "WORKFLOW_SEND_RECEIPT",
                className: "SendReceiptWorkflow",
                exported: true,
                exportName: "sendReceipt",
                name: "send-receipt",
                steps: [],
            };

            const result = reconcileWranglerBindings(root, baseInferred({ workflows: [ORDER_PIPELINE, SECOND] }));

            expect(result.added).toEqual(["workflows/SendReceiptWorkflow"]);
            expect(readConfig().workflows.map((entry: { class_name: string }) => entry.class_name)).toEqual(["OrderPipelineWorkflow", "SendReceiptWorkflow"]);
        });
    });

    describe("agents", () => {
        const SUPPORT = {
            bindingName: "AGENT_SUPPORT",
            className: "SupportAgentWorkflow",
            exported: true,
            exportName: "support",
            name: "agent-support",
        };

        it("provisions the agent as a workflows[] entry — an agent compiles onto a Workflow", () => {
            expect.assertions(5);

            const result = reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT] }));

            expect(result.changed).toBe(true);
            expect(result.added).toContain("workflows/SupportAgentWorkflow");

            const config = readConfig();

            expect(config.workflows).toEqual([{ binding: "AGENT_SUPPORT", class_name: "SupportAgentWorkflow", name: "agent-support" }]);
            // Agents are not Durable Objects: never bound, never migrated.
            expect(config.durable_objects.bindings.map((binding: { name: string }) => binding.name)).not.toContain("AGENT_SUPPORT");
            expect(config.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? [])).not.toContain(
                "SupportAgentWorkflow",
            );
        });

        it("is idempotent — a second run is a no-op", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT] }));

            const second = reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT] }));

            expect(second.changed).toBe(false);
        });

        it("skips an unexported agent and warns instead, with an agent-kind export gap", () => {
            expect.assertions(4);

            const result = reconcileWranglerBindings(root, baseInferred({ agents: [{ ...SUPPORT, exported: false }] }));

            expect(result.changed).toBe(false);
            expect(result.warnings.join(" ")).toContain("not exported by the worker entry");
            expect(readConfig().workflows).toBeUndefined();
            expect(result.exportGaps).toStrictEqual([{ className: "SupportAgentWorkflow", exportName: "support", kind: "agent", module: "agents" }]);
        });

        it("writes an agent alongside a workflow into the SAME workflows[] array without clobbering", () => {
            expect.assertions(2);

            const ORDER_PIPELINE = {
                bindingName: "WORKFLOW_ORDER_PIPELINE",
                className: "OrderPipelineWorkflow",
                exported: true,
                exportName: "orderPipeline",
                name: "order-pipeline",
                steps: [],
            };

            const result = reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT], workflows: [ORDER_PIPELINE] }));

            expect(result.added).toEqual(["workflows/OrderPipelineWorkflow", "workflows/SupportAgentWorkflow"]);
            expect(readConfig().workflows.map((entry: { class_name: string }) => entry.class_name)).toEqual(["OrderPipelineWorkflow", "SupportAgentWorkflow"]);
        });

        it("does not duplicate an agent already present in workflows[] (matched by class_name)", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT] }));

            const second = reconcileWranglerBindings(root, baseInferred({ agents: [SUPPORT] }));

            expect(second.added).toEqual([]);
        });
    });

    // Every other queue test starts from a config with no consumer, which is
    // the one state where "write the tuning" and "write only missing entries"
    // agree. These start from a consumer an earlier reconcile already wrote.
    describe("queue tuning on an existing queues.consumers[] entry", () => {
        const receiptQueue = (tuning: Record<string, unknown>) => {
            return { bindingName: "QUEUE_RECEIPT", exportName: "receiptQueue", mode: "push" as const, name: "receipt-queue", tuning };
        };

        const seedConsumer = (consumer: string): void => {
            writeFileSync(
                join(root, "wrangler.jsonc"),
                `${MINIMAL_WRANGLER.trimEnd().slice(0, -1)}    "queues": {
        "producers": [{ "binding": "QUEUE_RECEIPT", "queue": "receipt-queue" }],
        "consumers": [${consumer}],
    },
}
`,
                "utf8",
            );
        };

        const receiptConsumer = (): Record<string, unknown> =>
            readConfig().queues.consumers.find((entry: { queue: string }) => entry.queue === "receipt-queue") as Record<string, unknown>;

        it("deploys a dead-letter queue and retry budget added to defineQueue after the consumer was first written", () => {
            expect.assertions(4);

            seedConsumer(`{ "queue": "receipt-queue", "max_retries": 3 }`);

            const result = reconcileWranglerBindings(
                root,
                baseInferred({ queues: [receiptQueue({ deadLetterQueue: "receipt-dlq", maxRetries: 5, retryDelay: 60 })] }),
            );

            expect(result.changed).toBe(true);
            // A retune is an update, not a newly provisioned binding.
            expect({ added: result.added, updated: result.updated }).toStrictEqual({
                added: [],
                updated: ["queues.consumers/receipt-queue (max_retries, dead_letter_queue, retry_delay)"],
            });
            expect(receiptConsumer()).toStrictEqual({ dead_letter_queue: "receipt-dlq", max_retries: 5, queue: "receipt-queue", retry_delay: 60 });
            // Still exactly one consumer for the queue — updated in place, not appended.
            expect(readConfig().queues.consumers).toHaveLength(1);
        });

        it("leaves a field defineQueue does not declare exactly as the user wrote it", () => {
            expect.assertions(1);

            seedConsumer(`{ "queue": "receipt-queue", "max_batch_size": 50, "max_concurrency": 4, "max_retries": 3 }`);

            reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 8 })] }));

            expect(receiptConsumer()).toStrictEqual({ max_batch_size: 50, max_concurrency: 4, max_retries: 8, queue: "receipt-queue" });
        });

        it("is a no-op once the existing consumer already matches defineQueue", () => {
            expect.assertions(1);

            seedConsumer(`{ "queue": "receipt-queue", "max_retries": 5, "dead_letter_queue": "receipt-dlq" }`);

            const result = reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ deadLetterQueue: "receipt-dlq", maxRetries: 5 })] }));

            expect(result.changed).toBe(false);
        });

        it("keeps a retune when the same run also appends a new queue", () => {
            expect.assertions(1);

            seedConsumer(`{ "queue": "receipt-queue", "max_retries": 3 }`);

            const invoiceQueue = { bindingName: "QUEUE_INVOICE", exportName: "invoiceQueue", mode: "push" as const, name: "invoice-queue", tuning: {} };

            reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 }), invoiceQueue] }));

            expect(readConfig().queues.consumers).toStrictEqual([{ max_retries: 5, queue: "receipt-queue" }, { queue: "invoice-queue" }]);
        });

        it("retunes a field in place, keeping the comments and layout of a hand-edited queues block", () => {
            expect.assertions(3);

            writeFileSync(
                join(root, "wrangler.jsonc"),
                `${MINIMAL_WRANGLER.trimEnd().slice(0, -1)}    "queues": {
        // consumers first on purpose
        "consumers": [
            // bumped after the March incident
            { "queue": "receipt-queue", "max_retries": 3 },
        ],
        "producers": [{ "binding": "QUEUE_RECEIPT", "queue": "receipt-queue" }],
    },
}
`,
                "utf8",
            );

            reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 })] }));

            const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");

            expect(text).toContain("// bumped after the March incident");
            expect(text).toContain("// consumers first on purpose");
            // Only the one value changed: the entry stays on its line, and consumers stay ahead of producers.
            expect(text).toContain(`{ "queue": "receipt-queue", "max_retries": 5 },`);
        });

        // These start from a consumer that already carries a field `defineQueue`
        // no longer declares. Whether it goes depends on the ownership record in
        // package.json: only a field reconcile wrote, still at the value it wrote, is removed.
        describe("an option removed from defineQueue", () => {
            const seedManifest = (lunora?: Record<string, unknown>): void => {
                writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "app", ...(lunora === undefined ? {} : { lunora }) }, null, 4)}\n`, "utf8");
            };

            const readManifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;

            it("removes a dead-letter queue reconcile wrote once defineQueue drops it", () => {
                expect.assertions(3);

                seedConsumer(`{ "queue": "receipt-queue", "max_retries": 5, "dead_letter_queue": "receipt-dlq" }`);
                seedManifest({ queueTuning: { queues: { "receipt-queue": { dead_letter_queue: "receipt-dlq", max_retries: 5 } } } });

                const result = reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 })] }));

                expect(result.updated).toStrictEqual(["queues.consumers/receipt-queue (removed dead_letter_queue)"]);
                expect(receiptConsumer()).toStrictEqual({ max_retries: 5, queue: "receipt-queue" });
                // The record now owns only what is still declared.
                expect(readManifest()["lunora"]).toStrictEqual({ queueTuning: { queues: { "receipt-queue": { max_retries: 5 } } } });
            });

            it("keeps a field changed by hand after reconcile wrote it, and says so", () => {
                expect.assertions(3);

                seedConsumer(`{ "queue": "receipt-queue", "max_retries": 7 }`);
                seedManifest({ crons: ["0 3 * * *"], queueTuning: { queues: { "receipt-queue": { max_retries: 5 } } } });

                const result = reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({})] }));

                expect(receiptConsumer()).toStrictEqual({ max_retries: 7, queue: "receipt-queue" });
                expect(result.warnings.filter((warning) => warning.includes("changed by hand"))).toHaveLength(1);
                // Nothing is owned any more, so the record goes; the unrelated key stays.
                expect(readManifest()["lunora"]).toStrictEqual({ crons: ["0 3 * * *"] });
            });

            it("keeps the field when nothing records that reconcile wrote it", () => {
                expect.assertions(2);

                seedConsumer(`{ "queue": "receipt-queue", "max_retries": 5, "dead_letter_queue": "receipt-dlq" }`);
                seedManifest();

                const result = reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 })] }));

                expect(result.changed).toBe(false);
                expect(receiptConsumer()).toStrictEqual({ dead_letter_queue: "receipt-dlq", max_retries: 5, queue: "receipt-queue" });
            });

            it("takes back out, on a later pass, a field an earlier pass wrote", () => {
                expect.assertions(3);

                seedConsumer(`{ "queue": "receipt-queue" }`);
                seedManifest();

                reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ deadLetterQueue: "receipt-dlq", maxRetries: 5 })] }));

                expect(receiptConsumer()).toStrictEqual({ dead_letter_queue: "receipt-dlq", max_retries: 5, queue: "receipt-queue" });

                const second = reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({})] }));

                expect(second.updated).toStrictEqual(["queues.consumers/receipt-queue (removed max_retries, removed dead_letter_queue)"]);
                expect(receiptConsumer()).toStrictEqual({ queue: "receipt-queue" });
            });
        });

        // An `env.<name>` block declares its own consumers, usually under
        // environment-suffixed queue names that only its own producers map back to
        // a `defineQueue` export.
        describe("a consumer inside the env block a --env deploy targets", () => {
            const seedEnvironment = (consumer: string): void => {
                writeFileSync(
                    join(root, "wrangler.jsonc"),
                    `${MINIMAL_WRANGLER.trimEnd().slice(0, -1)}    "queues": {
        "producers": [{ "binding": "QUEUE_RECEIPT", "queue": "receipt-queue" }],
        "consumers": [{ "queue": "receipt-queue", "max_retries": 3 }],
    },
    "env": {
        "production": {
            "queues": {
                "producers": [{ "binding": "QUEUE_RECEIPT", "queue": "receipt-queue-prod" }],
                "consumers": [${consumer}],
            },
        },
    },
}
`,
                    "utf8",
                );
                writeFileSync(join(root, "package.json"), `{ "name": "app" }\n`, "utf8");
            };

            const productionConsumer = (): Record<string, unknown> => readConfig().env.production.queues.consumers[0] as Record<string, unknown>;

            it("retunes it through the block's own producer, but leaves dead_letter_queue to the user", () => {
                expect.assertions(4);

                seedEnvironment(`{ "queue": "receipt-queue-prod", "max_retries": 3, "max_concurrency": 2 }`);

                const result = reconcileWranglerBindings(
                    root,
                    baseInferred({ queues: [receiptQueue({ deadLetterQueue: "receipt-dlq", maxRetries: 5 })] }),
                    "production",
                );

                // COUNTS: both scopes retuned, one DLQ warning for the env consumer.
                expect(result.updated).toStrictEqual([
                    "queues.consumers/receipt-queue (max_retries, dead_letter_queue)",
                    "env.production.queues.consumers/receipt-queue-prod (max_retries)",
                ]);
                expect(productionConsumer()).toStrictEqual({ max_concurrency: 2, max_retries: 5, queue: "receipt-queue-prod" });
                expect(result.warnings.filter((warning) => warning.includes("dead_letter_queue"))).toHaveLength(1);
                expect(readConfig().env.production.queues.consumers).toHaveLength(1);
            });

            it("leaves the env block alone without --env", () => {
                expect.assertions(1);

                seedEnvironment(`{ "queue": "receipt-queue-prod", "max_retries": 3 }`);

                reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 })] }));

                expect(productionConsumer()).toStrictEqual({ max_retries: 3, queue: "receipt-queue-prod" });
            });

            it("takes back out a field an earlier --env pass wrote into the block", () => {
                expect.assertions(2);

                seedEnvironment(`{ "queue": "receipt-queue-prod" }`);

                reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({ maxRetries: 5 })] }), "production");

                expect(productionConsumer()).toStrictEqual({ max_retries: 5, queue: "receipt-queue-prod" });

                reconcileWranglerBindings(root, baseInferred({ queues: [receiptQueue({})] }), "production");

                expect(productionConsumer()).toStrictEqual({ queue: "receipt-queue-prod" });
            });
        });
    });

    // Every step here is add-only, so a renamed `defineQueue`/`defineWorkflow`
    // export leaves the previous entry behind. Removing it would mean deleting
    // config this tool cannot prove it wrote, so the orphan is named in
    // `warnings` instead.
    describe("orphaned workflows[] / queues entries", () => {
        const RECEIPT_QUEUE = { bindingName: "QUEUE_RECEIPT", exportName: "receiptQueue", mode: "push" as const, name: "receipt-queue", tuning: {} };
        const SEND_RECEIPT = {
            bindingName: "WORKFLOW_SEND_RECEIPT",
            className: "SendReceiptWorkflow",
            exported: true,
            exportName: "sendReceipt",
            name: "send-receipt",
            steps: [],
        };

        /** Seed the config with the pre-rename entries, then reconcile the renamed declarations onto it. */
        const seed = (block: string): void => {
            writeFileSync(join(root, "wrangler.jsonc"), `${MINIMAL_WRANGLER.trimEnd().slice(0, -1)}${block}}\n`, "utf8");
        };

        it("warns about a queues.consumers[] subscription no defineQueue export declares", () => {
            expect.assertions(3);

            seed(`    "queues": {
        "producers": [{ "binding": "QUEUE_EMAIL", "queue": "email-queue" }],
        "consumers": [{ "queue": "email-queue" }],
    },
`);

            const result = reconcileWranglerBindings(root, baseInferred({ queues: [RECEIPT_QUEUE] }));

            expect(result.warnings.join("\n")).toContain(`queues.consumers[] to "email-queue"`);
            expect(result.warnings.join("\n")).toContain(`queues.producers[] binding "QUEUE_EMAIL"`);
            // The orphan is reported, not deleted: removal would also drop a hand-wired subscription.
            expect(readConfig().queues.consumers.map((entry: { queue: string }) => entry.queue)).toStrictEqual(["email-queue", "receipt-queue"]);
        });

        it("warns about a workflows[] entry no defineWorkflow/defineAgent export generates", () => {
            expect.assertions(2);

            seed(`    "workflows": [{ "binding": "WORKFLOW_ORDER_PIPELINE", "class_name": "OrderPipelineWorkflow", "name": "order-pipeline" }],
`);

            const result = reconcileWranglerBindings(root, baseInferred({ workflows: [SEND_RECEIPT] }));

            expect(result.warnings.join("\n")).toContain(`workflows[] entry "OrderPipelineWorkflow"`);
            expect(readConfig().workflows.map((entry: { class_name: string }) => entry.class_name)).toStrictEqual([
                "OrderPipelineWorkflow",
                "SendReceiptWorkflow",
            ]);
        });

        it("stays quiet when the project declares no queue/workflow at all", () => {
            expect.assertions(1);

            seed(`    "queues": { "producers": [{ "binding": "QUEUE_EMAIL", "queue": "email-queue" }], "consumers": [{ "queue": "email-queue" }] },
    "workflows": [{ "binding": "WORKFLOW_ORDER_PIPELINE", "class_name": "OrderPipelineWorkflow", "name": "order-pipeline" }],
`);

            // Nothing declared means nothing to compare against: a hand-wired
            // config this tool has never touched must not be flagged.
            const result = reconcileWranglerBindings(root, baseInferred());

            expect(result.warnings).toStrictEqual([]);
        });

        it("stays quiet once the entries match the declarations", () => {
            expect.assertions(1);

            reconcileWranglerBindings(root, baseInferred({ queues: [RECEIPT_QUEUE], workflows: [SEND_RECEIPT] }));

            const second = reconcileWranglerBindings(root, baseInferred({ queues: [RECEIPT_QUEUE], workflows: [SEND_RECEIPT] }));

            expect(second.warnings).toStrictEqual([]);
        });
    });
});
