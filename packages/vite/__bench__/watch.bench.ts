import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin, ViteDevServer } from "vite";
import { afterAll, beforeAll, bench, describe } from "vitest";

import codegenPlugin from "../src/codegen-plugin";
import { createFixture, removeFixture, resolvedOptions } from "./fixture";

// What a save costs in dev, from the watcher event to the client being told.
//
//   - The synchronous watcher handlers (codegen + config-drift) for a file that
//     is NOT a Lunora input (`src/App.tsx`) and for one that is: this runs on
//     every save in the project, so it has to stay near zero.
//   - A Lunora schema/function save end to end — debounce, codegen, the
//     `postcodegen` probe, invalidation, the HMR notify — split into the FIRST
//     save after startup and a steady-state save, because they take different
//     paths (the first one used to build a whole ts-morph program from cold).
//
// The 100ms debounce is real time and identical on both sides of an A/B.
const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";
const saveIterations = reduced ? 2 : 6;

type Listener = (file: string) => void;

/** The slice of Vite's chokidar watcher the codegen plugin uses. */
interface Watcher {
    add: () => void;
    emit: (event: string, file: string) => void;
    off: (event: string, listener: Listener) => void;
    on: (event: string, listener: Listener) => void;
}

interface Harness {
    /** Resolves on the next HMR notification the plugin sends after a regeneration. */
    nextNotify: () => Promise<void>;
    server: ViteDevServer;
    watcher: Watcher;
}

const makeWatcher = (): Watcher => {
    const listeners = new Map<string, Set<Listener>>();

    return {
        add: (): void => {},
        emit: (event, file) => {
            for (const listener of listeners.get(event) ?? []) {
                listener(file);
            }
        },
        off: (event, listener) => {
            listeners.get(event)?.delete(listener);
        },
        on: (event, listener) => {
            listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
        },
    };
};

const makeHarness = (): Harness => {
    const watcher = makeWatcher();
    let notify: (() => void) | undefined;
    const send = (): void => {
        notify?.();
        notify = undefined;
    };
    const environment = (name: string) => {
        return { hot: { send }, moduleGraph: { idToModuleMap: new Map(), invalidateModule: (): void => {} }, name };
    };
    const noop = (): void => {};

    // Typed as the slice of `ViteDevServer` the codegen plugin reads.
    const server = {
        config: { logger: { error: noop, info: noop, warn: noop } },
        environments: { client: environment("client"), worker: environment("worker") },
        hot: { send },
        httpServer: { once: noop },
        restart: async (): Promise<void> => {},
        watcher,
    } as unknown as ViteDevServer;

    return {
        nextNotify: async () =>
            new Promise<void>((resolve) => {
                notify = resolve;
            }),
        server,
        watcher,
    };
};

interface Started {
    harness: Harness;
    plugin: Plugin;
}

/** Run the plugin through Vite's serve startup: config → configResolved → configureServer → buildStart. */
const start = async (fixture: string): Promise<Started> => {
    const plugin = codegenPlugin(resolvedOptions(fixture));
    const harness = makeHarness();
    const call = (hook: unknown, ...arguments_: unknown[]): unknown =>
        (hook as (...a: unknown[]) => unknown).call({ environment: { name: "client" } }, ...arguments_);

    call(plugin.config, {}, { command: "serve", mode: "development" });
    call(plugin.configResolved, {});
    call(plugin.configureServer, harness.server);
    await call(plugin.buildStart, {});

    return { harness, plugin };
};

const save = async ({ harness }: Started, file: string): Promise<void> => {
    // A real edit, so codegen has something to refresh.
    appendFileSync(file, "\n");

    const notified = harness.nextNotify();

    harness.watcher.emit("change", file);
    await notified;
};

let fixture: string;
let steady: Started;
// Its own instance: the scheduling row leaves a debounced regeneration behind.
let scheduling: Started;
const firstSavePool: Started[] = [];

beforeAll(async () => {
    fixture = createFixture("watch");
    steady = await start(fixture);
    scheduling = await start(fixture);

    // One started server per measured first save (plus warmup), made outside
    // the timed body: the first save is only "first" once.
    for (let index = 0; index < saveIterations + 1; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each run writes the same `_generated/`.
        firstSavePool.push(await start(fixture));
    }
});

afterAll(() => {
    removeFixture(fixture);
});

describe("watcher handlers (synchronous part)", () => {
    bench("non-Lunora file change (src/App.tsx)", () => {
        steady.harness.watcher.emit("change", join(fixture, "src", "App.tsx"));
    });

    bench("Lunora function change (schedules a regeneration)", () => {
        scheduling.harness.watcher.emit("change", join(fixture, "lunora", "mod0.ts"));
    });
});

describe("Lunora save → HMR notify (end to end)", () => {
    bench(
        "first save after startup",
        async () => {
            const started = firstSavePool.pop();

            if (started !== undefined) {
                await save(started, join(fixture, "lunora", "mod1.ts"));
            }
        },
        { iterations: saveIterations, time: 0, warmupIterations: 1 },
    );

    bench(
        "steady-state save",
        async () => {
            await save(steady, join(fixture, "lunora", "mod1.ts"));
        },
        { iterations: saveIterations, time: 0, warmupIterations: 1 },
    );
});
