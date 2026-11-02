#!/usr/bin/env node
/**
 * Guards the one Cloudflare limit that is invisible until upload: a Worker must
 * evaluate its whole global scope inside 1 s of CPU (error 10021, not raisable).
 *
 * Startup cost is the sum of every module a request-less isolate evaluates. The
 * generated `_generated/functions.ts` imports every function module, so that sum
 * grows with the app: a real app of about a thousand procedures profiles at ~0.4 s locally and is
 * rejected on Cloudflare. `check-worker-size.js` cannot see it (bytes, and on a
 * four-procedure template); no unit test can, because the cost lives in the graph.
 *
 * WHAT FAILS THE BUILD is deterministic: the number of modules and bytes reachable
 * from the entry through STATIC edges only (the `bundle-meta.json` metafile
 * `lunora build` writes). A dynamic `import()` edge is not counted, so deferring a
 * module lowers the number, and a new static import of a heavy package, or
 * reverting such a deferral, raises it. CPU time is NOT a gate: on a busy machine
 * the same build ranged from 171 ms to 418 ms between runs.
 *
 * BLIND SPOT: this sees graph growth only. Module-scope CPU work that adds no modules or
 * bytes (an eager `JSON.parse` of an existing payload, an O(N) loop in generated code) passes,
 * so a green result means "the startup graph did not grow", not "startup is safe".
 *
 * WHAT IS ONLY PRINTED is `wrangler check startup` (median of a few runs) as an
 * advisory CPU figure. It is local CPU, not Cloudflare CPU: the only calibration
 * point is a ~0.4-0.7 s local profile that was rejected upstream, which implies
 * Cloudflare is at least ~1.4x slower. Treat any factor as a heuristic.
 *
 * The reference app is synthetic, not a template. `templates/standalone` has four
 * procedures and cannot show per-procedure growth; this one has N procedures over T
 * tables, every function module importing one shared module that statically imports
 * `@lunora/auth`, the shape of a real app's shared auth / limiter / validator graph. It also
 * declares one push queue, one workflow and one agent that import the same shared module, so a
 * `LUNORA_LAZY_FUNCTIONS=1` run shows what the lazy build defers beyond the function registry.
 *
 * It also wires the builder-wired integrations whose SDKs are heavy — `.browser()`
 * (`@cloudflare/playwright`, ~3 MiB), `.payment()` with Stripe, `.hyperdrive()` with postgres.js,
 * `.hyperdriveGlobal()` on MySQL (mysql2), and every `@lunora/mcp/worker` server (the fetch
 * handler, `createToolServer`, `createFunctionMcpServer`, and a `createPaidMcpServer` given a tool
 * at module scope) — the way their docs say: through a loader the integration awaits on first use.
 * WHAT ALSO FAILS THE BUILD, in eager and lazy runs alike: any of those SDKs being evaluated at
 * startup (`INTEGRATION_SDKS`), reported with the static chain that reached it.
 *
 * Usage:
 *   pnpm run worker-startup:check     # fail when the eager graph exceeds the ceiling
 *   pnpm run worker-startup:update    # re-baseline after an intentional change
 *   node scripts/check-worker-startup.js --no-cpu    # skip the advisory CPU runs
 *
 * PREREQUISITE: `pnpm run build:packages:prod` (same reason as the size gate).
 *
 * Runs as its own CI job, NOT from `postinstall`: a failing postinstall gate turns
 * every job red in its setup step, with the cause invisible in the job that reports it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(rootDir, "worker-startup.json");
const update = process.argv.includes("--update");
const skipCpu = process.argv.includes("--no-cpu") || process.env.CI_SKIP_CPU === "1";

const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const PROCEDURES_PER_MODULE = 20;

/**
 * One `import … from` / `export … from` / `export { … }` statement. Sticky, and applied one
 * statement at a time by `isReexportOnly`: a single anchored regex repeating this pattern lets
 * the whitespace between statements split between neighbours in exponentially many ways, so a
 * barrel with one non-matching line at its end backtracks exponentially.
 */
const REEXPORT_STATEMENT =
    /(?:import\s*(?:type\s*)?(?:\{[^}]*\}|\*\s*as\s*[\w$]+|[\w$]+)\s*from\s*|export\s*(?:type\s*)?(?:\{[^}]*\}|\*(?:\s*as\s*[\w$]+)?)\s*(?:from\s*)?)(?:["'][^"']*["'])?\s*;?/uy;

const LEADING_WHITESPACE = /\s*/uy;

/** Whether `source` is made only of `import` / `export … from` / `export { … }` statements. */
const isReexportOnly = (source) => {
    let index = 0;

    for (;;) {
        LEADING_WHITESPACE.lastIndex = index;
        LEADING_WHITESPACE.test(source);
        index = LEADING_WHITESPACE.lastIndex;

        if (index === source.length) {
            return true;
        }

        REEXPORT_STATEMENT.lastIndex = index;

        if (!REEXPORT_STATEMENT.test(source) || REEXPORT_STATEMENT.lastIndex === index) {
            return false;
        }

        index = REEXPORT_STATEMENT.lastIndex;
    }
};

/**
 * `[owning package, SDK]` for each heavy SDK an app hands to a builder-wired integration. The
 * reference app wires all of them the documented way; none may be statically reachable from its
 * entry, or every isolate evaluates it at startup whether or not a request ever uses it.
 */
const INTEGRATION_SDKS = [
    ["browser", "@cloudflare/playwright"],
    ["payment", "stripe"],
    ["hyperdrive", "postgres"],
    ["hyperdrive", "mysql2"],
    ["mcp", "@modelcontextprotocol/sdk"],
];

/**
 * The integrations, wired into the template's entry the way their docs say: each SDK reaches its
 * integration only through a loader the integration awaits on first use, so it stays out of the
 * static graph. A static `import Stripe from "stripe"` here, or an integration that evaluated its
 * loader eagerly or imported the SDK at module scope, fails the forbidden-SDK check below.
 */
const INTEGRATION_WIRING = {
    builder: `    .browser((env) =>
        createBrowser({ allowedHosts: ["example.com"], binding: env.BROWSER as BrowserBindingLike, playwright: async () => await import("@cloudflare/playwright") }),
    )
    .payment((env) => ({
        adapter: createStripeAdapter({
            client: async () => {
                const { default: Stripe } = await import("stripe");

                return new Stripe(String(env.STRIPE_SECRET_KEY), { httpClient: Stripe.createFetchHttpClient() });
            },
            webhookSecret: String(env.STRIPE_WEBHOOK_SECRET),
        }),
    }))
    .hyperdrive((env) =>
        fromPostgresJs(async () => {
            const { default: postgres } = await import("postgres");

            return postgres(createHyperdrive(env.HYPERDRIVE as HyperdriveLike).connectionString);
        }),
    )
    .hyperdriveGlobal({
        engine: "mysql",
        exec: (env) =>
            buildMysqlExec(async () => {
                const { createPool } = await import("mysql2/promise");

                return createPool({ flags: ["FOUND_ROWS"], uri: createHyperdrive(env.HYPERDRIVE as HyperdriveLike).connectionString });
            }),
    })
    .build();
`,
    fetch: `        if (url.pathname === "/mcp") {
            mcp ??= createMcpFetchHandler({ token: String(env.LUNORA_ADMIN_TOKEN), url: url.origin });

            return mcp(request);
        }

        if (url.pathname === "/mcp/tools") {
            return createToolServer({ name: "tools", version: "0.0.0" }, []).then((server) => serveStateless(server, request));
        }

        if (url.pathname === "/mcp/functions") {
            return createFunctionMcpServer({ openRpcSpec: { methods: [], openrpc: "1.3.2" }, url: url.origin }).then((server) => serveStateless(server, request));
        }

        if (url.pathname === "/mcp/paid") {
            return paid.fetchHandler(request, env, context);
        }

        return app.fetch(request, env, context);`,
    imports: `import type { BrowserBindingLike } from "@lunora/browser";
import { createBrowser } from "@lunora/browser";
import type { HyperdriveLike } from "@lunora/hyperdrive";
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import { buildMysqlExec } from "@lunora/hyperdrive/global";
import type { McpFetchHandler } from "@lunora/mcp/worker";
import { createFunctionMcpServer, createMcpFetchHandler, createPaidMcpServer, createToolServer, serveStateless } from "@lunora/mcp/worker";
import { createStripeAdapter } from "@lunora/payment/stripe";

let mcp: McpFetchHandler | undefined;

// Built and given a tool at module scope, as the paid-tools docs show: neither may load the SDK.
const paid = createPaidMcpServer({ charge: { network: "base", recipient: { evm: "0x0000000000000000000000000000000000000000" } } });

paid.tool({ annotations: { readOnlyHint: true }, description: "health check", inputSchema: { properties: {}, type: "object" }, name: "ping" }, () => ({
    content: [{ text: "pong", type: "text" }],
}));

`,
};

/** Lay the reference app out as a symlink farm over the workspace (see check-worker-size.js). */
const materialize = (appDirectory, { procedures, tables }) => {
    cpSync(join(rootDir, "templates", "standalone"), appDirectory, { recursive: true });

    for (const file of ["package.json", "wrangler.jsonc"]) {
        const path = join(appDirectory, file);

        writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{name}}", "lunora-worker-startup-reference"), "utf8");
    }

    const manifestPath = join(appDirectory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    manifest.dependencies = {
        ...manifest.dependencies,
        "@lunora/agent": "^0.0.0",
        "@lunora/browser": "^0.0.0",
        "@lunora/hyperdrive": "^0.0.0",
        "@lunora/mcp": "^0.0.0",
        "@lunora/payment": "^0.0.0",
        "@lunora/queue": "^0.0.0",
        "@lunora/sql-store": "^0.0.0",
        "@lunora/workflow": "^0.0.0",
        ...Object.fromEntries(INTEGRATION_SDKS.map(([, name]) => [name, "*"])),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 4)}\n`, "utf8");

    // The bindings `generateApp`'s queue, workflow and agent need. The template's config is JSONC,
    // so they are spliced in ahead of its first key rather than parsed and rewritten.
    const wranglerPath = join(appDirectory, "wrangler.jsonc");

    writeFileSync(
        wranglerPath,
        readFileSync(wranglerPath, "utf8").replace(
            '"main":',
            `"browser": { "binding": "BROWSER" },
    "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "00000000000000000000000000000000" }],
    "queues": { "producers": [{ "binding": "QUEUE_JOBS", "queue": "jobs" }], "consumers": [{ "queue": "jobs" }] },
    "workflows": [
        { "name": "nightly", "binding": "WORKFLOW_NIGHTLY", "class_name": "NightlyWorkflow" },
        { "name": "agent-support", "binding": "AGENT_SUPPORT", "class_name": "SupportAgentWorkflow" },
    ],
    "main":`,
        ),
        "utf8",
    );

    // npm-shaped so the CLI's `pnpm exec` does not verify an absent lockfile.
    writeFileSync(join(appDirectory, "package-lock.json"), '{ "lockfileVersion": 3 }\n', "utf8");

    const modules = join(appDirectory, "node_modules");

    mkdirSync(join(modules, "@lunora"), { recursive: true });

    for (const directory of readdirSync(join(rootDir, "packages"))) {
        const source = join(rootDir, "packages", directory);
        const manifest = join(source, "package.json");

        if (existsSync(manifest)) {
            symlinkSync(source, join(modules, JSON.parse(readFileSync(manifest, "utf8")).name));
        }
    }

    const host = join(rootDir, "packages", "runtime", "node_modules");

    symlinkSync(join(host, "wrangler"), join(modules, "wrangler"));
    mkdirSync(join(modules, "@cloudflare"), { recursive: true });

    for (const name of readdirSync(join(host, "@cloudflare"))) {
        symlinkSync(join(host, "@cloudflare", name), join(modules, "@cloudflare", name));
    }

    // The integration SDKs, each from the package that declares it as its peer.
    for (const [owner, name] of INTEGRATION_SDKS) {
        mkdirSync(dirname(join(modules, name)), { recursive: true });

        // The host already provides it (a host that depends on the SDK itself): a second link to the same name would throw EEXIST.
        if (!existsSync(join(modules, name))) {
            symlinkSync(join(rootDir, "packages", owner, "node_modules", name), join(modules, name));
        }
    }

    mkdirSync(join(modules, ".bin"), { recursive: true });
    symlinkSync(join(host, ".bin", "wrangler"), join(modules, ".bin", "wrangler"));

    generateApp(appDirectory, procedures, tables);
};

/** `tables` indexed tables and `procedures` query / mutation / internalMutation procedures with realistic validators. */
const generateApp = (appDirectory, procedures, tables) => {
    const lunora = join(appDirectory, "lunora");
    const tableDefinitions = Array.from(
        { length: tables },
        (_, t) => `    t${t}: defineTable({
        ownerId: v.string(),
        title: v.string(),
        body: v.optional(v.string()),
        score: v.number(),
        status: v.union(v.literal("open"), v.literal("closed"), v.literal("archived")),
        tags: v.array(v.string()),
        createdAt: v.number(),
    })
        .shardBy("ownerId")
        .index("by_owner", ["ownerId"])
        .index("by_status", ["status", "createdAt"]),`,
    );

    writeFileSync(
        join(lunora, "schema.ts"),
        `import { ratelimit } from "./ratelimit/schema.js";
import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
${tableDefinitions.join("\n")}
    settings: defineTable({ key: v.string(), value: v.string() }).global({ backend: "hyperdrive" }),
}).extend(ratelimit.extension);
`,
        "utf8",
    );
    rmSync(join(lunora, "messages.ts"), { force: true });

    // The shared module every function module imports: stands in for an app's
    // auth / rate-limiter / validator graph. Referenced at module scope so the
    // bundler cannot drop it.
    mkdirSync(join(lunora, "lib"), { recursive: true });
    writeFileSync(
        join(lunora, "lib", "shared.ts"),
        'import { createAuth } from "@lunora/auth";\n\nexport const shared = (): typeof createAuth => createAuth;\n',
        "utf8",
    );

    // One push queue, one workflow and one agent, each reaching the shared module the way a real
    // consumer, workflow body or agent tool reaches the app's graph. They are what a lazy build
    // defers past the function registry: the queue registry, and the modules behind the exported
    // `WorkflowEntrypoint` classes, which the entry re-exports for wrangler.
    writeFileSync(
        join(lunora, "queues.ts"),
        `import { defineQueue } from "@lunora/queue";

import { shared } from "./lib/shared.js";

export const jobs = defineQueue<{ id: string }>({
    handler: async (_ctx, batch) => {
        shared();
        batch.ackAll();
    },
});
`,
        "utf8",
    );
    writeFileSync(
        join(lunora, "workflows.ts"),
        `import { defineWorkflow } from "@lunora/workflow";

import { shared } from "./lib/shared.js";

export const nightly = defineWorkflow<{ day: string }>({
    handler: async (ctx) => ctx.step.do("run", async () => typeof shared()),
});
`,
        "utf8",
    );
    writeFileSync(
        join(lunora, "agents.ts"),
        `import { defineAgent } from "@lunora/agent";

import { shared } from "./lib/shared.js";

export const support = defineAgent({ instructions: typeof shared(), model: "@cf/meta/llama-3.1-8b-instruct" });
`,
        "utf8",
    );

    // One action per action-tier integration, so codegen wires `ctx.browser`, `ctx.payments` and
    // `ctx.sql` and the generated `defineApp` grows `.browser()`, `.payment()` and `.hyperdrive()`.
    writeFileSync(
        join(lunora, "integrations.ts"),
        `import { action, v } from "#lunora/_generated/server.js";

export const render = action.input({ url: v.string() }).action(async ({ args, ctx }) => (await ctx.browser.screenshot(args.url)).byteLength);

export const billing = action.input({ referenceId: v.string() }).action(async ({ args, ctx }) => (await ctx.payments.check({ feature: "export", referenceId: args.referenceId })).allowed);

export const external = action.input({}).action(async ({ ctx }) => (await ctx.sql.query("select 1")).length);
`,
        "utf8",
    );

    const entry = join(appDirectory, "src", "server.ts");
    const source = readFileSync(entry, "utf8");
    const wired = source
        .replace("    .build();", INTEGRATION_WIRING.builder)
        .replace("        return app.fetch(request, env, context);", INTEGRATION_WIRING.fetch);

    if (wired === source || !wired.includes(INTEGRATION_WIRING.builder) || !wired.includes(INTEGRATION_WIRING.fetch)) {
        fail("check-worker-startup: the template entry changed shape — update INTEGRATION_WIRING's splice points.");
    }

    writeFileSync(
        entry,
        `${INTEGRATION_WIRING.imports}${wired}
export * from "../lunora/_generated/agents.js";
export * from "../lunora/_generated/workflows.js";
`,
        "utf8",
    );

    let made = 0;

    for (let moduleIndex = 0; made < procedures; moduleIndex++) {
        const lines = ['import { shared } from "./lib/shared.js";', 'import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";', ""];

        for (let slot = 0; slot < PROCEDURES_PER_MODULE && made < procedures; slot++, made++) {
            const table = `t${made % tables}`;

            if (made % 3 === 0) {
                lines.push(`export const list${slot} = query
    .input({ ownerId: v.string().max(256), status: v.optional(v.union(v.literal("open"), v.literal("closed"))), limit: v.optional(v.number()) })
    .query(async ({ args, ctx }) => {
        const rows = await ctx.db.query("${table}").withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId)).take(args.limit ?? 50);

        return { rows };
    });
`);
            } else if (made % 3 === 1) {
                lines.push(`export const create${slot} = mutation
    .input({ ownerId: v.string().max(256), title: v.string().max(200), body: v.optional(v.string().max(4000)), tags: v.array(v.string().max(32)), score: v.number() })
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("${table}", { ownerId: args.ownerId, title: args.title, body: args.body, tags: args.tags, score: args.score, status: "open", createdAt: Date.now() });

        return { id };
    });
`);
            } else {
                lines.push(`export const sweep${slot} = internalMutation
    .input({ ownerId: v.string().max(256), before: v.number() })
    .mutation(async ({ args, ctx }) => {
        const rows = await ctx.db.query("${table}").withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId)).take(100);

        for (const row of rows) {
            if (row.createdAt < args.before) {
                await ctx.db.delete("${table}", row._id);
            }
        }

        return { scanned: rows.length };
    });
`);
            }
        }

        lines.push("export const __shared = shared();", "");
        writeFileSync(join(lunora, `mod${String(moduleIndex).padStart(3, "0")}.ts`), lines.join("\n"), "utf8");
    }
};

/** Build the reference app with `lunora build`; returns its output directory. */
const build = (appDirectory) => {
    const cli = join(rootDir, "packages", "cli", "dist", "bin.mjs");

    if (!existsSync(cli)) {
        fail(`check-worker-startup: ${cli} is missing — run \`pnpm run build:packages:prod\` first.`);
    }

    try {
        // --no-strict-advisories: the synthetic procedures key rows on an argument
        // on purpose; that lint is about the app's security, not its startup.
        execFileSync(process.execPath, [cli, "build", "--no-strict-advisories", "--format", "json", "--out-dir", "out"], {
            cwd: appDirectory,
            encoding: "utf8",
            env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch {
        fail("check-worker-startup: `lunora build` failed on the reference app (its output is above).");
    }

    return join(appDirectory, "out");
};

/**
 * Modules and bytes reachable from the entry through static edges. The wrangler
 * metafile does not tag an entry point, so the roots are the inputs nothing else
 * imports; a dynamic-only module is not reachable, which is the point.
 */
const eagerGraph = (appDirectory, outDirectory) => {
    const metafilePath = join(outDirectory, "bundle-meta.json");

    if (!existsSync(metafilePath)) {
        fail("check-worker-startup: `lunora build` wrote no bundle-meta.json — the out-dir layout may have changed.");
    }

    const { inputs, outputs } = JSON.parse(readFileSync(metafilePath, "utf8"));
    const imported = new Set();

    for (const input of Object.values(inputs)) {
        for (const edge of input.imports) {
            imported.add(edge.path);
        }
    }

    const roots = Object.keys(inputs).filter((path) => !imported.has(path));

    /**
     * Breadth-first over static edges, remembering who first reached each module so a hit can
     * name the shortest chain that pulled it in. `leaves` follows no edge out of a module.
     */
    const walk = (leaves) => {
        const importer = new Map(roots.map((path) => [path, undefined]));
        const queue = roots.filter((path) => inputs[path]);
        const seen = new Set(queue);

        for (let index = 0; index < queue.length; index++) {
            const path = queue[index];

            if (leaves(path)) {
                continue;
            }

            for (const edge of inputs[path].imports) {
                if (edge.kind !== "dynamic-import" && !seen.has(edge.path) && inputs[edge.path]) {
                    seen.add(edge.path);
                    importer.set(edge.path, path);
                    queue.push(edge.path);
                }
            }
        }

        const chainTo = (path) => {
            const chain = [];

            for (let current = path; current !== undefined; current = importer.get(current)) {
                chain.unshift(current);
            }

            return chain;
        };

        return { chainTo, seen };
    };

    const { seen } = walk(() => false);

    if (roots.length === 0 || seen.size < 50) {
        fail(`check-worker-startup: measured ${seen.size} modules from ${roots.length} roots — the metafile layout may have changed.`);
    }

    let bytes = 0;

    for (const path of seen) {
        bytes += inputs[path].bytes;
    }

    // The forbidden-SDK check needs what is EVALUATED, which the count above over-approximates:
    // a barrel's metafile edge to a module the app never uses survives esbuild dropping that
    // module (sideEffects: false). So it stops at a module that put no bytes in the output,
    // unless that module is a pure re-export barrel, which never has bytes of its own. That is
    // also why the fixture calls every MCP server builder: one it never calls is dropped, and a
    // static SDK import in it would go unseen.
    const emitted = new Set(
        Object.values(outputs).flatMap((output) => Object.entries(output.inputs).flatMap(([path, { bytesInOutput }]) => (bytesInOutput > 0 ? [path] : []))),
    );
    const reexportOnly = (path) => {
        const source = join(appDirectory, path);

        return existsSync(source) && isReexportOnly(readFileSync(source, "utf8").replaceAll(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu, ""));
    };
    const evaluated = walk((path) => !emitted.has(path) && !reexportOnly(path));
    const forbidden = INTEGRATION_SDKS.flatMap(([, name]) => {
        const hit = [...evaluated.seen].find((path) => path.includes(`node_modules/${name}/`) && emitted.has(path));

        return hit === undefined ? [] : [{ chain: evaluated.chainTo(hit), name }];
    });

    return { bytes, forbidden, modules: seen.size, total: Object.keys(inputs).length };
};

/** Advisory only: `wrangler check startup`, median Active ms over a few runs. */
const advisoryCpu = (appDirectory, runs) => {
    const wrangler = join(appDirectory, "node_modules", ".bin", "wrangler");
    const samples = [];

    for (let index = 0; index < runs; index++) {
        try {
            const output = execFileSync(wrangler, ["check", "startup", "--outfile", join(appDirectory, "startup.cpuprofile")], {
                cwd: appDirectory,
                encoding: "utf8",
                env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
                stdio: ["ignore", "pipe", "ignore"],
                // Advisory output must never cost the job its budget: a hung workerd is abandoned.
                timeout: 120_000,
            });
            const match = /Active:\s+([\d.]+) ms/.exec(output);

            if (match) {
                samples.push(Number(match[1]));
            }
        } catch {
            return undefined;
        }
    }

    samples.sort((a, b) => a - b);

    return samples.length > 0 ? { max: samples.at(-1), median: samples[Math.floor(samples.length / 2)], min: samples[0] } : undefined;
};

const baseline = JSON.parse(readFileSync(fixturePath, "utf8"));
const root = mkdtempSync(join(tmpdir(), "lunora-worker-startup-"));
const appDirectory = join(root, "app");

let graph;
let cpu;

try {
    materialize(appDirectory, baseline);
    const outDirectory = build(appDirectory);

    graph = eagerGraph(appDirectory, outDirectory);
    cpu = skipCpu ? undefined : advisoryCpu(appDirectory, 5);
} finally {
    rmSync(root, { force: true, recursive: true });
}

const moduleCeiling = baseline.eagerModules + baseline.allowanceModules;
const byteCeiling = baseline.eagerBytes + baseline.allowanceBytes;

process.stdout.write(
    `worker startup (${baseline.procedures} procedures, ${baseline.tables} tables): ${graph.modules} of ${graph.total} modules / ${kib(graph.bytes)} evaluated eagerly — ` +
        `baseline ${baseline.eagerModules} / ${kib(baseline.eagerBytes)}, ceiling ${moduleCeiling} / ${kib(byteCeiling)}\n`,
);

if (cpu) {
    process.stdout.write(
        `  advisory CPU (local, NOT a gate): median ${cpu.median.toFixed(0)} ms, min ${cpu.min.toFixed(0)}, max ${cpu.max.toFixed(0)} — Cloudflare's limit is 1000 ms of ITS cpu, at least ~1.4x slower than this.\n`,
    );
}

if (graph.forbidden.length > 0) {
    fail(
        `An integration SDK is statically reachable from the reference Worker's entry, so every isolate evaluates it at\n` +
            `startup whether or not a request uses it. Load it on first use (a loader the integration awaits), not at\n` +
            `module scope:\n${graph.forbidden.map(({ chain, name }) => `  ${name}:\n    ${chain.join("\n    -> ")}`).join("\n")}`,
    );
}

if (update) {
    writeFileSync(fixturePath, `${JSON.stringify({ ...baseline, eagerBytes: graph.bytes, eagerModules: graph.modules }, undefined, 4)}\n`, "utf8");
    process.stdout.write("worker-startup.json updated.\n");
    process.exit(0);
}

if (graph.modules > moduleCeiling || graph.bytes > byteCeiling) {
    fail(
        `The reference Worker evaluates more at startup than its ceiling allows.\n` +
            `  modules: ${graph.modules} (ceiling ${moduleCeiling}, baseline ${baseline.eagerModules})\n` +
            `  bytes:   ${kib(graph.bytes)} (ceiling ${kib(byteCeiling)}, baseline ${kib(baseline.eagerBytes)})\n` +
            `Every module reachable through a static import runs when the isolate starts, and Cloudflare rejects a\n` +
            `Worker whose startup exceeds 1 s of CPU (error 10021). Find what became statically reachable (a new\n` +
            `top-level import of a heavy package from the generated app or a shared lunora/ module), and defer it\n` +
            `behind a dynamic import() if it is only needed on a request path. If the growth is intended, accept it\n` +
            `with \`pnpm run worker-startup:update\` so it is visible in review.`,
    );
}
