import type { Plugin } from "vite";
import { resolveConfig } from "vite";
import { afterAll, beforeAll, bench, describe } from "vitest";

import { lunora } from "../src/index";
import { createFixture, removeFixture } from "./fixture";

// The per-module price every request pays in dev (and every module in a build):
// each plugin's `resolveId` / `load` / `transform`, run over a realistic mix of
// 2000 ids. Dispatched the way Vite's plugin container does it — a hook's
// `filter.id` is tested first and the handler is skipped on a miss — so a hook
// that declares a filter is measured as the call it saves. (Under Rolldown a
// filtered-out hook is skipped natively, before any JS runs; this bench only
// sees the JS side of that.)
//
// Only Lunora's own sub-plugins are dispatched: the Cloudflare plugin and the
// error overlay are dependencies, not this package's code.
const ID_COUNT = 2000;

/** A plausible dev module graph: app files, deps, virtual ids, lunora/ sources, CSS, queries. */
const makeIds = (root: string): string[] => {
    const shapes = [
        (index: number) => `${root}/src/components/Component${String(index)}.tsx`,
        (index: number) => `${root}/node_modules/.vite/deps/dep_${String(index)}.js?v=1a2b3c4d`,
        (index: number) => `${root}/node_modules/react-dom/cjs/chunk-${String(index)}.js`,
        (index: number) => `\0virtual:some-plugin/${String(index)}`,
        (index: number) => `${root}/lunora/mod${String(index % 8)}.ts`,
        (index: number) => `${root}/lunora/_generated/api.ts?t=${String(index)}`,
        (index: number) => `${root}/src/styles/s${String(index)}.css?direct`,
        (index: number) => `/@id/__x00__virtual:id-${String(index)}`,
    ];

    return Array.from({ length: ID_COUNT }, (_, index) => (shapes[index % shapes.length] as (index: number) => string)(index));
};

type Handler = (this: unknown, ...arguments_: unknown[]) => unknown;

interface Dispatch {
    filter?: RegExp;
    handler: Handler;
}

const dispatchOf = (hook: unknown): Dispatch | undefined => {
    if (typeof hook === "function") {
        return { handler: hook as Handler };
    }

    if (hook !== null && typeof hook === "object" && "handler" in hook) {
        const { filter, handler } = hook as { filter?: { id?: unknown }; handler: Handler };

        return { filter: filter?.id instanceof RegExp ? filter.id : undefined, handler };
    }

    return undefined;
};

const pluginContext = { environment: { name: "worker" }, warn: (): void => {} };

let fixture: string;
let ids: string[];
let resolveIdHooks: Dispatch[];
let loadHooks: Dispatch[];
let transformHooks: Dispatch[];

const run = async (hooks: ReadonlyArray<Dispatch>, argumentsFor: (id: string) => unknown[]): Promise<void> => {
    for (const id of ids) {
        for (const { filter, handler } of hooks) {
            if (filter !== undefined && !filter.test(id)) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- Vite awaits each hook in turn, too.
            await handler.call(pluginContext, ...argumentsFor(id));
        }
    }
};

beforeAll(async () => {
    fixture = createFixture("hooks");
    ids = makeIds(fixture);

    // `resolveConfig` so the hooks run in the state a real server has them in
    // (framework detection done, options settled) — not a freshly built object.
    const plugins = lunora({ projectRoot: fixture }) as Plugin[];

    await resolveConfig({ configFile: false, logLevel: "silent", plugins, root: fixture }, "serve");

    const own = plugins.filter((plugin) => plugin.name.startsWith("lunora:"));

    resolveIdHooks = own.map((plugin) => dispatchOf(plugin.resolveId)).filter((hook) => hook !== undefined);
    loadHooks = own.map((plugin) => dispatchOf(plugin.load)).filter((hook) => hook !== undefined);
    transformHooks = own.map((plugin) => dispatchOf(plugin.transform)).filter((hook) => hook !== undefined);
});

afterAll(() => {
    removeFixture(fixture);
});

describe(`per-module hooks (${String(ID_COUNT)} ids)`, () => {
    bench("resolveId", async () => {
        await run(resolveIdHooks, (id) => [id, undefined, {}]);
    });

    bench("load", async () => {
        await run(loadHooks, (id) => [id, {}]);
    });

    bench("transform", async () => {
        await run(transformHooks, (id) => ["export {};", id, {}]);
    });
});
