/**
 * The Nitro-hosted templates' deploy entries, EXECUTED rather than read.
 *
 * `templates/nuxt` and `templates/analog` both point wrangler's `main` at a root
 * `worker.ts`. That file used to be `export { default } from "<nitro output>"`
 * plus `export { ShardDO }`, which looks complete: Nitro's `cloudflare-module`
 * handler really does export `scheduled` / `queue` / `email` / `tail`. But each
 * of those only calls `nitroApp.hooks.callHook("cloudflare:<event>")`, and
 * neither `@lunora/nuxt` nor the Analog template registers a listener for one —
 * so the composed Lunora app's `scheduled` (crons), `queue` (`defineQueue`
 * consumers) and `email` (inbound mail) were unreachable in the deployed worker.
 *
 * `lunora deploy` writes `triggers.crons` from the same codegen discovery, so
 * the first `lunora/crons.ts` a user adds gets a trigger provisioned, Cloudflare
 * fires it, the invocation SUCCEEDS against an empty hook, and the cron does
 * nothing. There is no error to notice.
 *
 * These templates are not workspace members and nothing type-checks or runs
 * them in-repo, so this suite writes each real `worker.ts` out against stubbed
 * imports and invokes the composed handlers — asserting what the deployed entry
 * DOES, not that its text mentions the right words.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** Inside `__tests__/` so vitest transforms the written modules; `.tmp` is gitignored repo-wide. */
const SCRATCH = join(HERE, ".tmp/nitro-entries");

/**
 * Nitro's `cloudflare-module` handler, reduced to what matters here: it OWNS
 * `fetch`, carries `tail`, and exports event handlers that only fire their
 * (unlistened) hook. A composed entry must keep Nitro's `fetch` and still reach
 * Lunora.
 */
const NITRO_STUB = `export const hookCalls = [];

export default {
    fetch: async () => new Response("nitro-ssr"),
    email: async () => {
        hookCalls.push("cloudflare:email");
    },
    queue: async () => {
        hookCalls.push("cloudflare:queue");
    },
    scheduled: async () => {
        hookCalls.push("cloudflare:scheduled");
    },
    tail: async () => {
        hookCalls.push("cloudflare:tail");
    },
};
`;

/** `lunora/server.ts` — `defineApp().build()`'s ComposedApp plus the `ShardDO` class it carries. */
const LUNORA_APP_STUB = `export const dispatched = [];

export class ShardDO {}

export default {
    ShardDO,
    email: async (...args) => {
        dispatched.push(["email", ...args]);
    },
    fetch: async () => new Response("lunora"),
    queue: async (...args) => {
        dispatched.push(["queue", ...args]);
    },
    scheduled: async (...args) => {
        dispatched.push(["scheduled", ...args]);
    },
    serverQuery: async () => new Response("rpc"),
};
`;

interface WorkerModule {
    default: {
        email?: (...args: unknown[]) => Promise<void>;
        fetch: (...args: unknown[]) => Promise<Response>;
        queue?: (...args: unknown[]) => Promise<void>;
        scheduled: (...args: unknown[]) => Promise<void>;
        tail?: (...args: unknown[]) => Promise<void>;
    };
    ShardDO: unknown;
}

interface Loaded {
    app: { dispatched: unknown[][] };
    nitro: { hookCalls: string[] };
    worker: WorkerModule;
}

/** The Nitro output specifier each template imports — the only per-template difference. */
const TEMPLATES = {
    analog: "./dist/analog/server/index.mjs",
    nuxt: "./.output/server/index.mjs",
} as const;

const loaded = new Map<string, Loaded>();

beforeAll(async () => {
    rmSync(SCRATCH, { force: true, recursive: true });

    for (const [template, nitroSpecifier] of Object.entries(TEMPLATES)) {
        const directory = join(SCRATCH, template);

        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "nitro-stub.ts"), NITRO_STUB, "utf8");
        writeFileSync(join(directory, "lunora-app-stub.ts"), LUNORA_APP_STUB, "utf8");

        // Only the two module specifiers are rewritten; the composition under
        // test is the template's own source, line for line.
        const source = readFileSync(join(REPO_ROOT, "templates", template, "worker.ts"), "utf8")
            .replace(`"${nitroSpecifier}"`, '"./nitro-stub"')
            .replace('"./lunora/server"', '"./lunora-app-stub"');

        writeFileSync(join(directory, "worker.ts"), source, "utf8");

        loaded.set(template, {
            app: (await import(`${directory}/lunora-app-stub.ts`)) as Loaded["app"],
            nitro: (await import(`${directory}/nitro-stub.ts`)) as Loaded["nitro"],
            worker: (await import(`${directory}/worker.ts`)) as WorkerModule,
        });
    }
});

afterAll(() => {
    rmSync(SCRATCH, { force: true, recursive: true });
});

describe.each(Object.keys(TEMPLATES))("templates/%s worker entry", (template) => {
    const entry = (): Loaded => loaded.get(template) as Loaded;

    it("exports the ShardDO class wrangler binds", () => {
        expect.hasAssertions();

        expect(typeof entry().worker.ShardDO).toBe("function");
    });

    it("dispatches a cron tick to the Lunora app, not only into Nitro's empty hook", async () => {
        expect.hasAssertions();

        const controller = { cron: "*/5 * * * *", noRetry: () => undefined, scheduledTime: 0 };

        await entry().worker.default.scheduled(controller, {}, {});

        expect(entry().app.dispatched).toContainEqual(["scheduled", controller, {}, {}]);
        // Nitro's own hook still fires, so a Nuxt/Nitro plugin listening on it keeps working.
        expect(entry().nitro.hookCalls).toContain("cloudflare:scheduled");
    });

    it("dispatches queue batches and inbound email to the Lunora app", async () => {
        expect.hasAssertions();

        await entry().worker.default.queue?.("batch", {}, {});
        await entry().worker.default.email?.("message", {}, {});

        expect(entry().app.dispatched.map(([name]) => name)).toStrictEqual(expect.arrayContaining(["email", "queue"]));
    });

    it("leaves fetch and the remaining entrypoints to Nitro (framework SSR owns every route)", async () => {
        expect.hasAssertions();

        expect(await (await entry().worker.default.fetch(new Request("https://app.test/"))).text()).toBe("nitro-ssr");

        await entry().worker.default.tail?.([], {}, {});

        expect(entry().nitro.hookCalls).toContain("cloudflare:tail");
    });
});
