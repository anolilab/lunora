/**
 * The class-A composed worker entry, EXECUTED rather than string-matched.
 *
 * A class-A app has no hand-written worker entry, so `virtual:lunora/worker` is
 * the only thing wrangler deploys — and it used to hand-roll `composeWorker`
 * with four options, exporting a bare `{ fetch }`. Everything else the generated
 * `defineApp()` builder wires (`scheduled`, `queue`, `email`, `cronJobs`,
 * `listSchemaTables`, `logArchive`, the studio introspectors, `identity`,
 * `jurisdiction`, `workflowsClient`, the `.global()` D1 writer, the DO-side
 * shard config) was unreachable. `lunora deploy` writes a `triggers.crons` entry
 * from the same codegen discovery, so the first `lunora/crons.ts` a user added
 * got a cron provisioned into a worker with no `scheduled` export — Cloudflare
 * fires it into nothing, silently.
 *
 * The emitted module is written to disk against a stub `_generated/app` and
 * imported for real, so this asserts what the deployed entry DOES, not what it
 * says: every handler the composed app carries reaches the module's default
 * export, and the plugin's `shard` options reach the builder.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildWorkerEntrySource, CLASS_A_WIRING } from "../src/framework-compose-plugin";

/** Inside `__tests__/` so vitest transforms + resolves the written modules; `.tmp` is gitignored repo-wide. */
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), ".tmp/class-a-entry");

/** What the stub `defineApp()` builder recorded, and the handlers its `.build()` handed back. */
interface EntryModule {
    default: {
        email?: (...args: unknown[]) => Promise<void>;
        fetch: (...args: unknown[]) => Promise<Response>;
        queue?: (...args: unknown[]) => Promise<void>;
        scheduled: (...args: unknown[]) => Promise<void>;
    };
    ShardDO: unknown;
}

/**
 * A stub of the generated `_generated/app.ts`. Its `.build()` returns the SAME
 * shape the real `ComposedApp` has — a Cloudflare module worker plus the
 * `ShardDO` class — so an entry that drops any of it fails here.
 */
const APP_STUB = `export const calls = [];
export const invoked = [];

const composed = {
    ShardDO: class ShardDO {},
    email: async (...args) => {
        invoked.push(["email", ...args]);
    },
    fetch: async () => new Response("lunora"),
    queue: async (...args) => {
        invoked.push(["queue", ...args]);
    },
    scheduled: async (...args) => {
        invoked.push(["scheduled", ...args]);
    },
    serverQuery: async () => new Response("rpc"),
};

const builder = {
    build: () => composed,
};

for (const method of ["cdc", "extend", "httpRouter", "maxRelationKeys", "observability", "reactiveCache", "relationExistsPushDown", "shard"]) {
    builder[method] = (...args) => {
        calls.push({ args, method });

        return builder;
    };
}

export const defineApp = () => builder;
`;

const SSR_STUB = `export default { fetch: async () => new Response("ssr") };\n`;

let entry: EntryModule;
let app: { calls: { args: unknown[]; method: string }[]; invoked: unknown[][] };

describe("class-A composed worker entry", () => {
    beforeAll(async () => {
        rmSync(SCRATCH, { force: true, recursive: true });
        mkdirSync(SCRATCH, { recursive: true });

        writeFileSync(join(SCRATCH, "app.ts"), APP_STUB, "utf8");
        writeFileSync(join(SCRATCH, "ssr-stub.ts"), SSR_STUB, "utf8");

        const source = buildWorkerEntrySource("tanstack-start", SCRATCH, {
            classModules: [],
            allowUnauthenticatedShardAccess: true,
            shard: { cdc: true, maxRelationKeys: 32, reactiveCache: { maxEntries: 5 } },
        });

        // Only the framework SSR handler is faked — the composition under test is
        // the emitted text, byte for byte.
        writeFileSync(join(SCRATCH, "entry.ts"), source.replace(CLASS_A_WIRING["tanstack-start"]!.imports, 'import * as ssrModule from "./ssr-stub";'), "utf8");

        entry = (await import(`${SCRATCH}/entry.ts`)) as EntryModule;
        app = (await import(`${SCRATCH}/app.ts`)) as typeof app;
    });

    afterAll(() => {
        rmSync(SCRATCH, { force: true, recursive: true });
    });

    it("exports the shard Durable Object class wrangler binds", () => {
        expect.hasAssertions();

        expect(typeof entry.ShardDO).toBe("function");
    });

    it("forwards scheduled — the cron entrypoint `lunora deploy` provisions a trigger for", async () => {
        expect.hasAssertions();

        expect(typeof entry.default.scheduled).toBe("function");

        const controller = { cron: "*/5 * * * *", noRetry: () => undefined, scheduledTime: 0 };

        await entry.default.scheduled(controller, {}, {});

        expect(app.invoked).toContainEqual(["scheduled", controller, {}, {}]);
    });

    it("forwards queue and email alongside fetch", async () => {
        expect.hasAssertions();

        await entry.default.queue?.("batch", {}, {});
        await entry.default.email?.("message", {}, {});

        expect(app.invoked.map(([name]) => name)).toStrictEqual(expect.arrayContaining(["email", "queue"]));

        const response = await entry.default.fetch(new Request("https://app.test/"), {}, {});

        await expect(response.text()).resolves.toBe("lunora");
    });

    it("routes the framework SSR handler in as the app's httpRouter", () => {
        expect.hasAssertions();

        expect(app.calls.map(({ method }) => method)).toStrictEqual(expect.arrayContaining(["httpRouter", "shard"]));
    });

    it("reaches every shard knob the plugin's `shard` option declares", () => {
        expect.hasAssertions();

        const byMethod = new Map(app.calls.map(({ args, method }) => [method, args]));

        expect(byMethod.get("cdc")).toStrictEqual([true]);
        expect(byMethod.get("maxRelationKeys")).toStrictEqual([32]);
        expect(byMethod.get("reactiveCache")).toStrictEqual([{ maxEntries: 5 }]);
    });

    it("opts into open shard access through the worker-options escape hatch", () => {
        expect.hasAssertions();

        const extend = app.calls.find(({ method }) => method === "extend")?.args[0] as () => Record<string, unknown>;

        expect(extend()).toStrictEqual({ allowUnauthenticatedShardAccess: true });
    });
});
