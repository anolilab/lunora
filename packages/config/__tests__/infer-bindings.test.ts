import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inferLunoraBindings } from "../src/infer-bindings";

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
    users: defineTable({ email: v.string() }).global(),
});
`;

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
});
`;

const WRANGLER = `{
    "name": "app",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07"
}
`;

const ENTRY_SHARD_ONLY = `import { createShardDO } from "../../lunora/_generated/shard.js";

export const ShardDO = createShardDO({});

export default { fetch() { return new Response("ok"); } };
`;

const ENTRY_SHARD_AND_SCHEDULER = `import { createShardDO } from "../../lunora/_generated/shard.js";

export { SchedulerDO } from "./scheduler-do.js";
export const ShardDO = createShardDO({});
`;

describe("inferLunoraBindings", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-infer-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const write = (relativePath: string, content: string): void => {
        const fullPath = join(root, relativePath);

        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, content, "utf8");
    };

    it("provisions only the Durable Objects the worker entry exports", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_AND_SCHEDULER);

        const result = await inferLunoraBindings({ projectRoot: root });
        const bindings = result.durableObjects.map((object) => object.binding).toSorted((a, b) => a.localeCompare(b));

        expect(bindings).toEqual(["SCHEDULER", "SHARD"]);
        expect(result.durableObjects.find((object) => object.binding === "SHARD")?.className).toBe("ShardDO");
    });

    it("does NOT bind SessionDO when @lunora/auth is used but no SessionDO is exported", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", `${ENTRY_SHARD_ONLY}\nimport { createAuth } from "@lunora/auth";\nexport const auth = createAuth();`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAuth).toBe(true);
        expect(result.durableObjects.some((object) => object.binding === "SESSION")).toBe(false);
        expect(result.signals.some((signal) => signal.includes("SessionDO"))).toBe(true);
    });

    it("infers D1 from a .global() table even with no env.DB access", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/schema.ts", SCHEMA_WITH_GLOBAL);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.needsD1).toBe(true);
    });

    it("does not infer D1 for a shard-only schema", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/schema.ts", SCHEMA_NO_GLOBAL);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.needsD1).toBe(false);
    });

    it("falls back to a known entry path when wrangler has no main", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", '{ "name": "app", "compatibility_date": "2026-04-07" }');
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("reports no Durable Objects when the worker entry cannot be found", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", '{ "name": "app", "main": "does/not/exist.ts" }');

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.durableObjects).toEqual([]);
    });

    it("detects an aliased re-export of a Durable Object class", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", "class AppShard {}\nexport { AppShard as ShardDO };");

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("does NOT bind a class that is only exported as a type (inline `type` modifier)", async () => {
        expect.assertions(1);

        // es-module-lexer lists `ShardDO` as an export here even though it
        // compiles away; binding it would break `wrangler deploy`.
        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", `${ENTRY_SHARD_ONLY}\nexport { type SchedulerDO } from "./scheduler-types.js";`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
    });

    it("infers D1 from an env.DB access even without a global schema", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/schema.ts", SCHEMA_NO_GLOBAL);
        write("lunora/admin.ts", "export const handler = (c) => c.env.DB.prepare('select 1');");

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.needsD1).toBe(true);
    });

    it("infers AI from a @lunora/ai import", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/summarize.ts", `import { generateText } from "@lunora/ai";\nexport const summarize = () => generateText;`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAi).toBe(true);
        expect(result.signals.some((signal) => signal.includes("AI"))).toBe(true);
    });

    it("infers AI from an env.AI access without importing @lunora/ai", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/classify.ts", "export const handler = (c) => c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {});");

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAi).toBe(true);
    });

    it("does not infer AI for a project that uses neither @lunora/ai nor env.AI", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAi).toBe(false);
    });

    const CONTAINERS_TS = `import { defineContainer } from "@lunora/container";

export const transcoder = defineContainer({ image: "./containers/transcoder", maxInstances: 5 });
`;

    it("infers a declared container as exported via the star re-export", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/containers.ts", CONTAINERS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export * from "../../lunora/_generated/containers.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.containers).toHaveLength(1);
        expect(result.containers[0]).toMatchObject({ bindingName: "CONTAINER_TRANSCODER", className: "TranscoderContainer", exported: true });
        expect(result.signals.join(" ")).toContain('container "transcoder" declared and exported');
    });

    it("infers a declared container as exported via a named re-export", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/containers.ts", CONTAINERS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export { TranscoderContainer } from "../../lunora/_generated/containers.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.containers[0]).toMatchObject({ exported: true });
    });

    it("flags a declared container the entry does not export", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/containers.ts", CONTAINERS_TS);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.containers[0]).toMatchObject({ exported: false });
        expect(result.signals.join(" ")).toContain("not exported by the worker entry");
    });

    it("reports no containers for a project without lunora/containers.ts", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.containers).toEqual([]);
    });

    const WORKFLOWS_TS = `import { defineWorkflow } from "@lunora/workflow";

export const orderPipeline = defineWorkflow({ run: async () => {} });
`;

    it("infers a declared workflow as exported via the star re-export", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/workflows.ts", WORKFLOWS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export * from "../../lunora/_generated/workflows.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows).toHaveLength(1);
        expect(result.workflows[0]).toMatchObject({ bindingName: "WORKFLOW_ORDER_PIPELINE", className: "OrderPipelineWorkflow", exported: true });
        expect(result.signals.join(" ")).toContain('workflow "orderPipeline" declared and exported');
    });

    it("infers a declared workflow as exported via a named re-export", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/workflows.ts", WORKFLOWS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export { OrderPipelineWorkflow } from "../../lunora/_generated/workflows.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows[0]).toMatchObject({ exported: true });
    });

    it("flags a declared workflow the entry does not export", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/workflows.ts", WORKFLOWS_TS);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows[0]).toMatchObject({ exported: false });
        expect(result.signals.join(" ")).toContain("not exported by the worker entry");
    });

    it("reports no workflows for a project without lunora/workflows.ts", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows).toEqual([]);
    });

    it("infers payment from a @lunora/payment import and hints at the provider secrets, without binding a class", async () => {
        expect.assertions(4);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/billing.ts", `import { createPayment } from "@lunora/payment";\nexport const payment = () => createPayment;`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesPayment).toBe(true);
        // Payment rides the existing ShardDO via ctx.db — no extra DO binding.
        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
        expect(result.signals.some((signal) => signal.includes("@lunora/payment"))).toBe(true);
        expect(result.signals.some((signal) => signal.includes("STRIPE_SECRET_KEY") && signal.includes("POLAR_ACCESS_TOKEN"))).toBe(true);
    });

    it("does not infer payment for a project that does not import @lunora/payment", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesPayment).toBe(false);
    });

    // Cloudflare-coverage capability arms (plans 027/028/031/032/035/036).
    // Each maps an `@lunora/*` import to a capability flag + signal. Hint
    // bindings (kv/hyperdrive) emit a `hint:` signal; self-describing bindings
    // (browser/images/analytics) emit a plain provisioning signal. Pipelines is
    // NOT import-driven (it ships from @lunora/analytics, reached via
    // ctx.pipelines) and is covered by its own test below.
    it.each([
        ["@lunora/kv", "usesKv", /hint: @lunora\/kv/u],
        ["@lunora/hyperdrive", "usesHyperdrive", /hint: @lunora\/hyperdrive/u],
        ["@lunora/browser", "usesBrowser", /browser \(@lunora\/browser/u],
        ["@lunora/images", "usesImages", /images \(@lunora\/images/u],
        ["@lunora/analytics", "usesAnalytics", /analytics_engine_datasets/u],
    ] as const)("infers %s usage and emits the expected signal", async (source, flag, signalRe) => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/feature.ts", `import { thing } from "${source}";\nexport const handler = () => thing;`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result[flag]).toBe(true);
        expect(result.signals.join(" ")).toMatch(signalRe);
    });

    it("leaves every Cloudflare-coverage flag false for a project importing none of them", async () => {
        expect.assertions(6);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesKv).toBe(false);
        expect(result.usesHyperdrive).toBe(false);
        expect(result.usesPipelines).toBe(false);
        expect(result.usesBrowser).toBe(false);
        expect(result.usesImages).toBe(false);
        expect(result.usesAnalytics).toBe(false);
    });

    it("infers pipelines from a ctx.pipelines access and emits the hint signal", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // Pipelines ships from @lunora/analytics; the binding hint keys off the
        // `ctx.pipelines` read, not a (non-existent) @lunora/pipelines import.
        write("lunora/ingest.ts", `import { createPipelines } from "@lunora/analytics";\nexport const handler = (ctx) => ctx.pipelines.send([]);`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesPipelines).toBe(true);
        expect(result.signals.some((signal) => signal.includes("wrangler pipelines create"))).toBe(true);
    });

    it("does not flip pipelines for an analytics-only project (no ctx.pipelines read)", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/metrics.ts", `import { thing } from "@lunora/analytics";\nexport const handler = (ctx) => ctx.analytics.writeDataPoint(thing);`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAnalytics).toBe(true);
        expect(result.usesPipelines).toBe(false);
    });

    it("infers mail from a @lunora/mail import and emits a hint signal (LOW 3 regression)", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/welcome.ts", `import { sendMail } from "@lunora/mail";\nexport const handler = () => sendMail;`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesMail).toBe(true);
        // No extra Cloudflare binding — mail secret lives in .dev.vars only.
        expect(result.durableObjects.map((object) => object.binding)).toEqual(["SHARD"]);
        expect(result.signals.some((signal) => signal.includes("RESEND_API_KEY"))).toBe(true);
    });

    it("does not infer mail for a project that does not import @lunora/mail", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesMail).toBe(false);
    });
});
