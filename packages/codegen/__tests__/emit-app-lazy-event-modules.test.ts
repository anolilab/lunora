import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "esbuild";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

/**
 * With the lazy registry, the modules the worker reaches only from an event entry — the push-queue
 * registry (and through it every queue-declaring module) and the `onEmail` agent definitions — load
 * on that event, not when the isolate evaluates the script. Bundled the way wrangler bundles a Worker
 * (one esbuild file, `import()` kept in-bundle) with recording stubs, so the assertions cover
 * evaluation order rather than text.
 */

interface Trace {
    agentsEvaluated: boolean;
    dispatched: unknown[];
    emails: number;
    emailTargets: unknown[];
    queuesEvaluated: boolean;
}

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-app-lazy-events-"));

const STUBS: Record<string, string> = {
    "../agents.js": `globalThis.eventTrace.agentsEvaluated = true; export const support = { name: "support" };`,
    "./crons.js": "export const LUNORA_CRONS = [];",
    "./functions.js": "export const LUNORA_FUNCTIONS = {};",
    "./queues.js": `globalThis.eventTrace.queuesEvaluated = true; export const LUNORA_QUEUE_REGISTRY = { jobs: { exportName: "jobs" } };`,
    "./shard.js": "export const createShardDO = () => class ShardDO {};",
    "@lunora/agent/inbound": `
        export const dispatchAgentEmail = (targets) => {
            globalThis.eventTrace.emailTargets.push(...targets);
            return async () => { globalThis.eventTrace.emails += 1; };
        };
    `,
    "@lunora/queue": `
        export const createQueueCaptureSink = () => undefined;
        export const dispatchQueueBatch = async (_batch, registry) => { globalThis.eventTrace.dispatched.push(registry); };
        export const shouldCaptureQueue = () => false;
    `,
    "@lunora/runtime": `
        export const createWorker = (options) => {
            return {
                fetch: async () => new Response("ok"),
                queue: (batch, env, context) => options.queue(batch, env, context, {}, undefined, undefined),
                scheduled: async () => {},
                serverQuery: async () => new Response("ok"),
            };
        };
        export const resolveLogArchiveFromEnv = () => undefined;
    `,
};

const stubs: Plugin = {
    name: "generated-app-stubs",
    setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (arguments_) => (arguments_.path in STUBS ? { namespace: "stub", path: arguments_.path } : undefined));
        pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (arguments_) => {
            return { contents: STUBS[arguments_.path], loader: "js" };
        });
    },
};

/** Bundle the emitted `app.ts` into one file and import it with a fresh trace. */
const load = async (source: string): Promise<{ defineApp: () => any; trace: Trace }> => {
    const trace: Trace = { agentsEvaluated: false, dispatched: [], emails: 0, emailTargets: [], queuesEvaluated: false };
    const outfile = join(scratch, `app-${randomUUID()}.mjs`);

    (globalThis as { eventTrace?: Trace }).eventTrace = trace;

    await build({
        bundle: true,
        format: "esm",
        logLevel: "silent",
        outfile,
        platform: "neutral",
        plugins: [stubs],
        stdin: { contents: source, loader: "ts", resolveDir: scratch },
    });

    const module = (await import(pathToFileURL(outfile).href)) as { defineApp: () => any };

    return { defineApp: module.defineApp, trace };
};

const namespace = {
    get: () => {
        return {};
    },
    idFromName: () => {
        return {};
    },
};

const lazyOptions = { ...baseOptions, emailAgents: [{ className: "SupportAgentWorkflow", exportName: "support" }], hasQueue: true, lazyFunctions: true };

describe("emitApp — event-only modules with the lazy function registry", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
        delete (globalThis as { eventTrace?: Trace }).eventTrace;
    });

    it("has no value import of the queue registry, the agent definitions or the inbound dispatcher", () => {
        expect.assertions(1);

        const staticImports = emitApp(lazyOptions)
            .split("\n")
            .filter((line) => line.startsWith("import ") && !line.startsWith("import type "));

        expect(staticImports.filter((line) => /queues\.js|agents\.js|@lunora\/agent/u.test(line))).toStrictEqual([]);
    });

    it("loads the queue registry on the first batch, not at startup", async () => {
        expect.assertions(3);

        const { defineApp, trace } = await load(emitApp(lazyOptions));
        const app = defineApp()
            .shard(() => namespace)
            .build();

        expect(trace.queuesEvaluated).toBe(false);

        await app.queue({ messages: [], queue: "jobs" }, {}, { waitUntil: () => {} });

        expect(trace.queuesEvaluated).toBe(true);
        expect(trace.dispatched).toStrictEqual([{ jobs: { exportName: "jobs" } }]);
    });

    it("loads the onEmail agent definitions on the first message and builds the dispatcher once", async () => {
        expect.assertions(4);

        const { defineApp, trace } = await load(emitApp(lazyOptions));
        const app = defineApp()
            .shard(() => namespace)
            .build();

        expect(trace.agentsEvaluated).toBe(false);

        await Promise.all([app.email({}, {}, { waitUntil: () => {} }), app.email({}, {}, { waitUntil: () => {} })]);

        expect(trace.agentsEvaluated).toBe(true);
        expect(trace.emailTargets).toStrictEqual([{ agent: { name: "support" }, className: "SupportAgentWorkflow" }]);
        expect(trace.emails).toBe(2);
    });
});
