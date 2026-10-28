#!/usr/bin/env node
/**
 * Cold-start bench: what a lazy registry moves from Worker startup to the first
 * call of each function, eager vs `--lazy-functions`.
 *
 * Per sample it boots a fresh local runtime (`unstable_startWorker`, one workerd
 * process and so one isolate) on the frozen `lunora build` bundle, and waits on the
 * runtime's own `ready` promise. Then, in order:
 *
 *   1. `saas:me` on the root shard — the first response, and with boot the
 *      cold-to-first-response time;
 *   2. `insights:headline` on the tenant's shard, which wakes that Durable Object so
 *      its start-up is not charged to the first sampled function;
 *   3. one cold call per sampled module, in a per-sample shuffled order;
 *   4. `--warm` further calls of each.
 *
 * The sample is one function per generated module that a caller can reach without
 * writing: each domain's `queries:list`, plus the offline action of every heavy
 * domain's `integrations` module (S3 presign, e2b template, protobuf, tldts, the
 * OpenAI provider). Modes alternate per sample, so drift in machine load hits both.
 *
 *   node scripts/cold-start.mjs --preset customer
 *   node scripts/cold-start.mjs --preset customer --samples 30 --warm 3
 *   node scripts/cold-start.mjs --domains 10 --heavy-share 0.5 --samples 4
 *
 * Results go to `.bench/results/` (gitignored) as JSON; a table is printed.
 * Prerequisite: built packages (`pnpm --filter "@lunora/bench..." run build:prod`).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createEmailVerificationToken } from "better-auth/api";
import { createServiceClient } from "lunorash/client/service";
import { unstable_startWorker as startWorker } from "wrangler";

import { appDirectory, domainKey, OFFLINE_CALLS, shapeOf, sizeFromArgs } from "./generate.mjs";
import { benchDirectory, buildMode, parseModes, sizeLabel, withSizedApp } from "./sized-app.mjs";

const { values } = parseArgs({
    options: {
        domains: { type: "string" },
        "heavy-share": { type: "string" },
        keep: { default: false, type: "boolean" },
        modes: { default: "eager,lazy", type: "string" },
        preset: { type: "string" },
        samples: { default: "20", type: "string" },
        warm: { default: "2", type: "string" },
    },
});

const modes = parseModes(values.modes);
const samples = Number(values.samples);
const warmCalls = Number(values.warm);
const size = sizeFromArgs({ domains: values.domains, heavyShare: values["heavy-share"], preset: values.preset });
const presetName = sizeLabel(values, size);
const stateDirectory = join(benchDirectory, "cold-state");

/*
 * Local stand-ins for the app's secrets, random per run. Presigning is local
 * computation, so the S3 export runs its real code path against an endpoint that
 * does not exist.
 */
process.env.CI = "1";
process.env.WRANGLER_SEND_METRICS = "false";

const secret = () => randomBytes(24).toString("hex");
const plain = (value) => {
    return { type: "plain_text", value };
};
const bindings = {
    BETTER_AUTH_SECRET: plain(secret()),
    BETTER_AUTH_URL: plain("http://127.0.0.1"),
    LUNORA_ADMIN_TOKEN: plain(secret()),
    MAIL_FROM: plain("Bench <noreply@bench.test>"),
    S3_ACCESS_KEY_ID: plain(secret().slice(0, 20).toUpperCase()),
    S3_BUCKET: plain("bench-exports"),
    S3_ENDPOINT: plain("https://s3.bench.invalid"),
    S3_SECRET_ACCESS_KEY: plain(secret()),
    STORAGE_SIGNING_SECRET: plain(secret()),
};
const ownerPassword = secret();

/** One fresh runtime on `mode`'s frozen bundle; resolves once workerd reports it ready. */
const boot = async (mode) => {
    const started = performance.now();
    const worker = await startWorker({
        bindings,
        build: { bundle: false },
        config: join(appDirectory, "wrangler.jsonc"),
        dev: { inspector: false, logLevel: "none", persist: stateDirectory, remote: false, server: { hostname: "127.0.0.1", port: 0 }, watch: false },
        entrypoint: join(benchDirectory, `out-${mode}`, "server.js"),
    });

    await worker.ready;

    return { bootMs: performance.now() - started, origin: new URL(await worker.url).origin, started, worker };
};

/** A typed RPC client over the local runtime, carrying the session cookie and same-origin `Origin` the way a browser would. */
const clientFor = (origin, cookie) =>
    createServiceClient({
        fetch: async (request) => {
            const headers = new Headers(request.headers);

            headers.set("cookie", cookie);
            headers.set("origin", origin);

            return fetch(new URL(new URL(request.url).pathname, origin), { body: await request.text(), headers, method: request.method });
        },
    });

const reference = (path) => {
    return { __lunoraRef: path };
};

/**
 * better-auth's JSON endpoints, as the user at `clientIp`; returns the body and the
 * cookie jar after the response. Each simulated owner has its own address: better-auth
 * rate-limits sign-up per client IP, and every request here comes from one host.
 */
const authPost = async (origin, path, body, { clientIp, cookie = "" }) => {
    const response = await fetch(new URL(`/api/auth/${path}`, origin), {
        body: JSON.stringify(body),
        headers: { "cf-connecting-ip": clientIp, "content-type": "application/json", cookie, origin, "x-forwarded-for": clientIp },
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`POST /api/auth/${path} → ${String(response.status)}: ${await response.text()}`);
    }

    // Later cookies replace earlier ones of the same name, as in a browser's jar.
    const jar = new Map(
        [...cookie.split("; "), ...response.headers.getSetCookie().map((line) => line.split(";")[0])].filter(Boolean).map((pair) => [pair.split("=")[0], pair]),
    );

    return { body: await response.json(), cookie: [...jar.values()].join("; ") };
};

/**
 * Signs up `count` owners, each with an active organisation of its own, into the
 * persisted state the samples boot on. One caller per sample: the app's `read`
 * rate limit (200 per 10 s per caller) is persisted, so a shared caller would be
 * refused after the first isolate; and each sample then meets a tenant shard no
 * earlier sample has woken.
 */
const signUp = async (mode, count) => {
    rmSync(stateDirectory, { force: true, recursive: true });

    const { origin, worker } = await boot(mode);
    const sessions = [];

    try {
        for (let index = 0; index < count; index++) {
            const owner = { email: `owner-${String(index)}@bench.test`, password: ownerPassword };
            const clientIp = `10.0.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`;

            await authPost(origin, "sign-up/email", { ...owner, name: `Bench Owner ${String(index)}` }, { clientIp });

            // The app requires a verified address. The link would arrive by mail; its token is a JWT over the
            // secret bound above, so it is minted here the way better-auth mints it.
            const token = await createEmailVerificationToken(bindings.BETTER_AUTH_SECRET.value, owner.email);
            const verified = await fetch(new URL(`/api/auth/verify-email?token=${token}`, origin), { redirect: "manual" });

            if (verified.status >= 400) {
                throw new Error(`verify-email → ${String(verified.status)}: ${await verified.text()}`);
            }

            const signedIn = await authPost(origin, "sign-in/email", owner, { clientIp });
            const created = await authPost(
                origin,
                "organization/create",
                { name: `Bench Org ${String(index)}`, slug: `bench-org-${String(index)}` },
                { clientIp, cookie: signedIn.cookie },
            );
            const active = await authPost(origin, "organization/set-active", { organizationId: created.body.id }, { clientIp, cookie: created.cookie });
            const me = await clientFor(origin, active.cookie).query(reference("saas:me"), {});

            if (me?.organizationId !== created.body.id || me.orgRole !== "owner") {
                throw new Error(`signed-up caller is not the organisation's owner: ${JSON.stringify(me)}`);
            }

            sessions.push({ cookie: active.cookie, organizationId: created.body.id });
        }

        return sessions;
    } finally {
        await worker.dispose();
    }
};

/** One cold-callable function per generated module: each domain's `queries:list`, and every heavy domain's offline integration action. */
const sampleCalls = () => {
    const calls = [];

    for (let index = 0; index < size.domains; index++) {
        const key = domainKey(index);
        const { integration } = shapeOf(index, size.heavyShare);

        calls.push({ args: {}, heavy: false, kind: "query", path: `domains_${key}_queries:list` });

        if (integration) {
            const { args, name } = OFFLINE_CALLS[integration];

            calls.push({ args, heavy: true, integration, kind: "action", path: `domains_${key}_integrations:${name}` });
        }
    }

    return calls;
};

/** Deterministic Fisher–Yates on a seeded LCG, so a rerun calls in the same orders. */
const shuffled = (items, seed) => {
    const copy = [...items];
    let state = seed;

    for (let index = copy.length - 1; index > 0; index--) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

        const other = state % (index + 1);

        [copy[index], copy[other]] = [copy[other], copy[index]];
    }

    return copy;
};

const timed = async (call) => {
    const started = performance.now();

    try {
        await call();

        return { ms: performance.now() - started, ok: true };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), ms: performance.now() - started, ok: false };
    }
};

const runSample = async (mode, calls, session, seed) => {
    const { bootMs, origin, started, worker } = await boot(mode);

    try {
        const client = clientFor(origin, session.cookie);
        const onTenant = { shardKey: session.organizationId };
        const first = await timed(async () => client.query(reference("saas:me"), {}));
        const coldToFirstMs = performance.now() - started;
        const tenantWake = await timed(async () => client.query(reference("insights:headline"), {}, onTenant));
        const invoke = async (call) => (call.kind === "action" ? client.action : client.query)(reference(call.path), call.args, onTenant);
        const cold = [];
        const warm = [];

        for (const call of shuffled(calls, seed)) {
            // Sequential on purpose: each call's latency is measured alone.
            cold.push({ ...(await timed(async () => invoke(call))), heavy: call.heavy, path: call.path });
        }

        for (let round = 0; round < warmCalls; round++) {
            for (const call of calls) {
                warm.push({ ...(await timed(async () => invoke(call))), heavy: call.heavy, path: call.path });
            }
        }

        return { bootMs, coldToFirstMs, first, mode, tenantWake, cold, warm };
    } finally {
        await worker.dispose();
    }
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);

    return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
};

mkdirSync(join(benchDirectory, "results"), { recursive: true });

const loadBefore = loadavg();
const calls = sampleCalls();
const runs = Object.fromEntries(modes.map((mode) => [mode, []]));
const shape = await withSizedApp(size, { keep: values.keep }, async (generated) => {
    for (const mode of modes) {
        process.stderr.write(`[cold] ${presetName}: building ${mode}…\n`);
        buildMode(mode);
    }

    // The runtime needs a local Hyperdrive connection string to boot; nothing here opens it. Set only now:
    // during `lunora build` it would turn on the lazy smoke-load, which `startup.mjs` builds without.
    const hyperdrive = new URL("postgres://127.0.0.1:5432/bench");

    hyperdrive.username = "bench";
    hyperdrive.password = secret();
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= String(hyperdrive);

    const sessions = await signUp(modes[0], samples * modes.length);

    for (let sample = 0; sample < samples; sample++) {
        const order = sample % 2 === 0 ? modes : modes.toReversed();

        for (const [position, mode] of order.entries()) {
            const session = sessions[sample * modes.length + position];

            // One runtime at a time: concurrent isolates would contend for the CPU being measured.
            runs[mode].push(await runSample(mode, calls, session, sample + 1));
        }

        process.stderr.write(
            `[cold] sample ${String(sample + 1)}/${String(samples)}: ${modes.map((mode) => `${mode} first ${runs[mode].at(-1).coldToFirstMs.toFixed(0)} ms`).join(", ")} (load ${loadavg()[0].toFixed(1)})\n`,
        );
    }

    return generated;
});

const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: appDirectory, encoding: "utf8" }).trim();
const summary = Object.fromEntries(
    Object.entries(runs).map(([mode, list]) => {
        // A failed call's latency is the error path's, so only successful calls enter the percentiles.
        const cold = list.flatMap((run) => run.cold).filter((result) => result.ok);
        const warm = list.flatMap((run) => run.warm).filter((result) => result.ok);
        const failures = list.flatMap((run) => [run.first, run.tenantWake, ...run.cold, ...run.warm]).filter((result) => !result.ok);

        return [
            mode,
            {
                boot: stats(list.map((run) => run.bootMs)),
                coldCall: stats(cold.map((result) => result.ms)),
                coldCallHeavy: stats(cold.filter((result) => result.heavy).map((result) => result.ms)),
                coldCallPlain: stats(cold.filter((result) => !result.heavy).map((result) => result.ms)),
                coldSweep: stats(list.map((run) => run.cold.reduce((sum, result) => sum + result.ms, 0))),
                coldToFirst: stats(list.map((run) => run.coldToFirstMs)),
                failures: failures.length,
                firstErrors: [...new Set(failures.map((result) => result.error))].slice(0, 5),
                firstResponse: stats(list.map((run) => run.first.ms)),
                warmCall: stats(warm.map((result) => result.ms)),
            },
        ];
    }),
);
const report = {
    at: new Date().toISOString(),
    calls: calls.length,
    gitSha,
    loadavg: { after: loadavg(), before: loadBefore },
    preset: presetName,
    runs,
    samples,
    shape,
    size,
    summary,
    warmCalls,
};
const file = join(benchDirectory, "results", `cold-start-${presetName}-${report.at.replaceAll(/[:.]/gu, "-")}.json`);

writeFileSync(file, `${JSON.stringify(report, undefined, 4)}\n`, "utf8");

const metrics = [
    ["boot (start → ready)", "boot"],
    ["first response (saas:me)", "firstResponse"],
    ["cold → first response", "coldToFirst"],
    ["cold first call, all", "coldCall"],
    ["cold first call, heavy SDK", "coldCallHeavy"],
    ["cold first call, plain", "coldCallPlain"],
    ["cold sweep per isolate", "coldSweep"],
    ["warm call", "warmCall"],
];
const format = (value) => (value === undefined ? "–" : value.toFixed(1));
const rows = metrics.map(([label, key]) => [
    label,
    ...modes.map((mode) => {
        const { n, p50, p95, p99 } = summary[mode][key];

        return `${format(p50)} / ${format(p95)} / ${format(p99)} (n=${String(n)})`;
    }),
]);
const header = ["ms p50 / p95 / p99", ...modes];
const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");

process.stdout.write(
    `\ncold start — ${presetName} (${String(samples)} isolates per mode, ${String(calls.length)} functions, ${String(warmCalls)} warm rounds, load ${loadBefore[0].toFixed(1)} → ${loadavg()[0].toFixed(1)}, ${gitSha})\n`,
);
process.stdout.write(`${line(header)}\n${line(widths.map((width) => "-".repeat(width)))}\n${rows.map((row) => line(row)).join("\n")}\n`);
process.stdout.write(`failures: ${modes.map((mode) => `${mode} ${String(summary[mode].failures)}`).join(", ")}\n\n${file}\n`);
