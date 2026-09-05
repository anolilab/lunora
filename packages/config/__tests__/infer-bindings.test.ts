import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSandboxUsage } from "@lunora/codegen";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inferLunoraBindings, packageNamesFromBindings } from "../src/infer-bindings";

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

    it("binds no auth Durable Object for a D1-backed auth app, and says which mode it is in", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", `${ENTRY_SHARD_ONLY}\nimport { createAuth } from "@lunora/auth";\nexport const auth = createAuth();`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesAuth).toBe(true);
        expect(result.durableObjects.some((object) => object.binding === "SESSION")).toBe(false);
        // The hint used to promise that exporting `SessionDO` produced DO-backed
        // sessions. `@lunora/auth` has never called that class, so following the hint
        // got you a bound, secret-configured, entirely unused Durable Object. It now
        // names the mechanism that actually exists.
        expect(result.signals.some((signal) => signal.includes("pass `namespace` to .auth()"))).toBe(true);
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

    it("lexes src/worker.ts over an adapter-built main, matching what deploy bundles", async () => {
        expect.assertions(1);

        // Class-B (SvelteKit/Astro): `main` points at the framework adapter's
        // build output, which exists after `vite build` and exports only the SSR
        // fetch handler — while `lunora deploy` bundles `src/worker.ts` as the
        // positional entry. Lexing `main` there reads every class as unexported.
        write("wrangler.jsonc", '{ "name": "app", "main": "build/_worker.js", "compatibility_date": "2026-04-07" }');
        write("build/_worker.js", "export default { fetch() { return new Response('ok'); } };\n");
        write("src/worker.ts", ENTRY_SHARD_ONLY);

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

    it("binds a class the entry also names in a type-only IMPORT", async () => {
        expect.assertions(1);

        // `import { type ShardDO, createShardDO }` is the ordinary way to reach
        // the generated class's type. The old detector was a whole-file
        // `/\btype\s+ShardDO\b/` with no `export` anchor, so that import read as
        // a type-only EXPORT and reconcile refused the SHARD binding — after
        // which `wrangler-validator` failed the deploy telling the user "your
        // dev server auto-reconciles this on startup", which is precisely what
        // it had just declined to do.
        write("wrangler.jsonc", WRANGLER);
        write(
            "src/server/index.ts",
            `import type { ShardDO } from "../../lunora/_generated/shard.js";\nimport { type SchedulerDO, createShardDO } from "../../lunora/_generated/shard.js";\n\nexport const ShardDO = createShardDO({});\nexport const SchedulerDO = createShardDO({});\n\nexport default { fetch() { return new Response("ok"); } };\n`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.durableObjects.map((object) => object.binding).toSorted((a, b) => a.localeCompare(b))).toEqual(["SCHEDULER", "SHARD"]);
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

    it("still detects a value class export when a separate `export type { … }` of the same name coexists", async () => {
        expect.assertions(1);

        // A value re-export of the generated class AND a separate type-only export of
        // the same name — the type-only line must NOT suppress the value binding, or
        // `wrangler deploy` fails on a missing `class_name`. (Prior whole-file regex bug.)
        write("wrangler.jsonc", WRANGLER);
        write("lunora/containers.ts", CONTAINERS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export { TranscoderContainer } from "../../lunora/_generated/containers.js";
export type { TranscoderContainer } from "../../lunora/_generated/containers.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.containers[0]).toMatchObject({ exported: true });
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

    it("treats a class-A composed worker entry as exporting the declared classes", async () => {
        expect.assertions(3);

        // Regression: every class-A template sets `main: "virtual:lunora/worker"`
        // and ships NO entry file, so the `existsSync(main)` probe used to fall
        // through to "no worker entry" — every declaration was stamped
        // `exported: false`, reconcile filtered them out, and the app deployed
        // green then failed at runtime on a missing binding.
        write("wrangler.jsonc", `{\n    "name": "app",\n    "main": "virtual:lunora/worker",\n    "compatibility_date": "2026-04-07"\n}\n`);
        write("lunora/workflows.ts", WORKFLOWS_TS);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows[0]).toMatchObject({ className: "OrderPipelineWorkflow", exported: true });
        expect(result.durableObjects).toEqual([{ binding: "SHARD", className: "ShardDO" }]);
        expect(result.signals.join(" ")).not.toContain("not exported by the worker entry");
    });

    it("reports no workflows for a project without lunora/workflows.ts", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.workflows).toEqual([]);
    });

    const AGENTS_TS = `import { defineAgent } from "@lunora/agent";

export const support = defineAgent({ model: "m" });
`;

    it("infers a declared agent as exported via the star re-export", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/agents.ts", AGENTS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export * from "../../lunora/_generated/agents.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]).toMatchObject({ bindingName: "AGENT_SUPPORT", className: "SupportAgentWorkflow", exported: true });
        expect(result.signals.join(" ")).toContain('agent "support" declared and exported');
    });

    it("infers a declared agent as exported via a named re-export of the AgentWorkflow class", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/agents.ts", AGENTS_TS);
        write(
            "src/server/index.ts",
            `${ENTRY_SHARD_ONLY}
export { SupportAgentWorkflow } from "../../lunora/_generated/agents.js";
`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.agents[0]).toMatchObject({ exported: true });
    });

    it("flags a declared agent the entry does not export", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("lunora/agents.ts", AGENTS_TS);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.agents[0]).toMatchObject({ exported: false });
        expect(result.signals.join(" ")).toContain('agent "support" is declared but SupportAgentWorkflow is not exported');
    });

    it("reports no agents for a project without lunora/agents.ts", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.agents).toEqual([]);
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
    // NOT import-driven (it ships from @lunora/bindings/pipelines, reached via
    // ctx.pipelines) and is covered by its own test below.
    it.each([
        ["@lunora/bindings/kv", "usesKv", /hint: @lunora\/bindings\/kv/u],
        ["@lunora/hyperdrive", "usesHyperdrive", /hint: @lunora\/hyperdrive/u],
        ["@lunora/browser", "usesBrowser", /browser \(@lunora\/browser/u],
        ["@lunora/bindings/images", "usesImages", /images \(@lunora\/bindings\/images/u],
        ["@lunora/bindings/analytics", "usesAnalytics", /analytics_engine_datasets/u],
        ["@lunora/x402/charge", "usesX402Charge", /hint: @lunora\/x402\/charge/u],
        ["@lunora/x402/pay", "usesX402Pay", /hint: @lunora\/x402\/pay/u],
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

    it("provisions BROWSER from a sandbox browserTool import even without a direct @lunora/browser import", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // The batteries-included browserTool drives ctx.browser inside the sandbox
        // dispatcher, so importing it must provision the BROWSER binding.
        write("lunora/agents.ts", `import { browserTool } from "@lunora/agent/sandbox";\nexport const t = browserTool();`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(true);
        expect(result.signals.join(" ")).toMatch(/browser \(@lunora\/browser/u);
    });

    it("provisions BROWSER from a browserTool re-exported by the @lunora/agent main entry", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // The documented import is from the package root (index.ts re-exports it),
        // so this must provision BROWSER too — not only the /sandbox subpath.
        write("lunora/agents.ts", `import { browserTool, defineAgent } from "@lunora/agent";\nexport const t = browserTool();`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(true);
    });

    it("does not provision BROWSER for a sandbox containerTool-only import", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/agents.ts", `import { containerTool } from "@lunora/agent/sandbox";\nexport const t = containerTool("worker");`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(false);
    });

    it("does not provision BROWSER for a type-only browserTool import", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // A type-only import wires nothing at runtime, so it must not provision a
        // binding — mirroring codegen's `declaration.isTypeOnly()` exclusion.
        write("lunora/agents.ts", `import type { browserTool } from "@lunora/agent/sandbox";\nexport const t = 1;`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(false);
    });

    it("does not provision BROWSER for a specifier-level `{ type browserTool }` import (CONFIG-01)", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // The declaration itself is a VALUE import (containerTool rides along as a
        // real value), but `browserTool` specifically is marked `type` — it compiles
        // away, so it must not provision BROWSER. The OLD regex matched `browserTool`
        // anywhere in the brace list regardless of a per-specifier `type` prefix.
        write("lunora/agents.ts", `import { containerTool, type browserTool } from "@lunora/agent/sandbox";\nexport const t = containerTool("worker");`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(false);
    });

    it("does not provision BROWSER for a browserTool import inside a comment (CONFIG-01)", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // The OLD detector was a blind whole-file regex sweep, so a commented-out
        // import (never a real declaration) still matched.
        write("lunora/agents.ts", '// import { browserTool } from "@lunora/agent/sandbox";\nexport const t = 1;');

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(false);
    });

    it("does not provision BROWSER for a browserTool import outside lunora/ (src/-only) (CONFIG-01)", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // discover/sandbox.ts (codegen) only ever scans `lunora/` — a `src/`-only
        // import never registers the sandbox:invoke dispatcher, so config must not
        // provision BROWSER for it either (config previously also scanned `src/`).
        write("src/tools.ts", `import { browserTool } from "@lunora/agent/sandbox";\nexport const t = browserTool();`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesBrowser).toBe(false);
    });

    describe("agreement with discover/sandbox.ts (CONFIG-01 shared fixture matrix)", () => {
        /**
         * Feed the SAME `lunora/agents.ts` source through both browserTool
         * detectors — codegen's AST-based `discoverSandboxUsage` and config's
         * lexer-based `inferLunoraBindings` — and assert they agree. This is the
         * drift guard: a fix applied to one detector without the other would
         * fail here.
         */
        const agree = async (source: string): Promise<{ codegen: boolean; config: boolean }> => {
            write("wrangler.jsonc", WRANGLER);
            write("src/server/index.ts", ENTRY_SHARD_ONLY);
            write("lunora/agents.ts", source);

            const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
            const codegenResult = discoverSandboxUsage(project, join(root, "lunora"));
            const configResult = await inferLunoraBindings({ projectRoot: root });

            return { codegen: codegenResult.usesSandboxBrowser, config: configResult.usesBrowser };
        };

        it("agree: value import (main entry)", async () => {
            expect.assertions(1);

            const result = await agree(`import { browserTool } from "@lunora/agent";\nexport const t = browserTool();`);

            expect(result).toStrictEqual({ codegen: true, config: true });
        });

        it("agree: value import (/sandbox subpath)", async () => {
            expect.assertions(1);

            const result = await agree(`import { browserTool } from "@lunora/agent/sandbox";\nexport const t = browserTool();`);

            expect(result).toStrictEqual({ codegen: true, config: true });
        });

        it("agree: whole-declaration type-only import", async () => {
            expect.assertions(1);

            const result = await agree(`import type { browserTool } from "@lunora/agent/sandbox";\nexport const t = 1;`);

            expect(result).toStrictEqual({ codegen: false, config: false });
        });

        it("agree: specifier-level `{ type browserTool }` import", async () => {
            expect.assertions(1);

            const result = await agree(`import { containerTool, type browserTool } from "@lunora/agent/sandbox";\nexport const t = containerTool("worker");`);

            expect(result).toStrictEqual({ codegen: false, config: false });
        });

        it("agree: commented-out import", async () => {
            expect.assertions(1);

            const result = await agree('// import { browserTool } from "@lunora/agent/sandbox";\nexport const t = 1;');

            expect(result).toStrictEqual({ codegen: false, config: false });
        });
    });

    it("infers pipelines from a ctx.pipelines access and emits the hint signal", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // Pipelines ships from @lunora/bindings/pipelines but is codegen-wired onto
        // ActionCtx; the binding hint keys off the `ctx.pipelines` read, not the import.
        write("lunora/ingest.ts", `import { createPipelines } from "@lunora/bindings/pipelines";\nexport const handler = (ctx) => ctx.pipelines.send([]);`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesPipelines).toBe(true);
        expect(result.signals.some((signal) => signal.includes("wrangler pipelines create"))).toBe(true);
    });

    it("does not flip pipelines for an analytics-only project (no ctx.pipelines read)", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/metrics.ts", `import { thing } from "@lunora/bindings/analytics";\nexport const handler = (ctx) => ctx.analytics.writeDataPoint(thing);`);

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

    it("infers notify from a @lunora/notify import so its VAPID/FCM secrets reach the pre-flights", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/notify.ts", `import { defineNotify, webPushFromEnv } from "@lunora/notify";\nexport default defineNotify({ webPush: webPushFromEnv });`);

        const result = await inferLunoraBindings({ projectRoot: root });

        // `packageNamesFromBindings` is the ONLY producer feeding `requiredSecrets`,
        // and it can only emit a CAPABILITY_SOURCES source — so with no notify entry
        // the five secrets declared in `package-secrets-registry.ts` reached nothing:
        // not `.dev.vars.example`, not the missing-secret pre-flight. Web Push then
        // failed silently on the deployed worker.
        expect(result.usesNotify).toBe(true);
        expect(packageNamesFromBindings(result)).toContain("@lunora/notify");
    });

    it("infers r2sql from a ctx.r2sql access so its R2_SQL_* secrets reach the pre-flights", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        // `ctx.r2sql` is codegen-wired onto ActionCtx (nothing imports the subpath),
        // exactly like `ctx.pipelines` — so the signal is the access, not an import.
        write("lunora/reports.ts", `export const handler = (ctx) => ctx.r2sql.query("select 1");`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesR2sql).toBe(true);
        expect(packageNamesFromBindings(result)).toContain("@lunora/bindings/r2sql");
    });

    it("does not infer mail for a project that does not import @lunora/mail", async () => {
        expect.assertions(1);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesMail).toBe(false);
    });

    it("infers the flagship binding + hint from a Flagship binding-mode lunora/flags.ts", async () => {
        expect.assertions(3);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write(
            "lunora/flags.ts",
            `import { defineFlags } from "@lunora/flags";\nimport { flagshipProvider } from "@lunora/flags/providers/flagship";\nexport default defineFlags({ provider: flagshipProvider({ binding: "FLAGS" }) });`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesFlags).toBe(true);
        expect(result.flagshipBinding).toBe("FLAGS");
        expect(result.signals.some((signal) => signal.includes('flagship binding ({ binding: "FLAGS"'))).toBe(true);
    });

    it("infers flags but no flagship binding for an HTTP-mode Flagship provider", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write(
            "lunora/flags.ts",
            `import { defineFlags } from "@lunora/flags";\nimport { flagshipProvider } from "@lunora/flags/providers/flagship";\nexport default defineFlags({ provider: flagshipProvider({ appId: "app-abc", accountId: "acct" }) });`,
        );

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesFlags).toBe(true);
        expect(result.flagshipBinding).toBeUndefined();
    });

    it("infers flags but no binding for a custom OpenFeature provider", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);
        write("lunora/flags.ts", `import { defineFlags } from "@lunora/flags";\nexport default defineFlags({ provider: (env) => new Custom(env.KEY) });`);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesFlags).toBe(true);
        expect(result.flagshipBinding).toBeUndefined();
    });

    it("does not infer flags for a project without a lunora/flags.ts", async () => {
        expect.assertions(2);

        write("wrangler.jsonc", WRANGLER);
        write("src/server/index.ts", ENTRY_SHARD_ONLY);

        const result = await inferLunoraBindings({ projectRoot: root });

        expect(result.usesFlags).toBe(false);
        expect(result.flagshipBinding).toBeUndefined();
    });
});
