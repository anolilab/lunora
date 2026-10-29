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
 * `@lunora/auth`, the shape of a real app's shared auth / limiter / validator graph.
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

/** Lay the reference app out as a symlink farm over the workspace (see check-worker-size.js). */
const materialize = (appDirectory, { procedures, tables }) => {
    cpSync(join(rootDir, "templates", "standalone"), appDirectory, { recursive: true });

    for (const file of ["package.json", "wrangler.jsonc"]) {
        const path = join(appDirectory, file);

        writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{name}}", "lunora-worker-startup-reference"), "utf8");
    }

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
    symlinkSync(join(host, "@cloudflare"), join(modules, "@cloudflare"));
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
const eagerGraph = (outDirectory) => {
    const metafilePath = join(outDirectory, "bundle-meta.json");

    if (!existsSync(metafilePath)) {
        fail("check-worker-startup: `lunora build` wrote no bundle-meta.json — the out-dir layout may have changed.");
    }

    const { inputs } = JSON.parse(readFileSync(metafilePath, "utf8"));
    const imported = new Set();

    for (const input of Object.values(inputs)) {
        for (const edge of input.imports) {
            imported.add(edge.path);
        }
    }

    const roots = Object.keys(inputs).filter((path) => !imported.has(path));
    const seen = new Set();
    const stack = [...roots];

    while (stack.length > 0) {
        const path = stack.pop();

        if (seen.has(path) || !inputs[path]) {
            continue;
        }

        seen.add(path);

        for (const edge of inputs[path].imports) {
            if (edge.kind !== "dynamic-import") {
                stack.push(edge.path);
            }
        }
    }

    if (roots.length === 0 || seen.size < 50) {
        fail(`check-worker-startup: measured ${seen.size} modules from ${roots.length} roots — the metafile layout may have changed.`);
    }

    let bytes = 0;

    for (const path of seen) {
        bytes += inputs[path].bytes;
    }

    return { bytes, modules: seen.size, total: Object.keys(inputs).length };
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

    graph = eagerGraph(outDirectory);
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
