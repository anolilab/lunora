/**
 * Node-side smoke test for the workerd-only `CirrusContainer` base class. The
 * `cloudflare:workers` import inside `@cloudflare/containers` is aliased to a
 * stub (see `vitest.config.ts`), and the Durable Object context is faked with
 * the surface the upstream `Container` constructor actually touches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import CirrusContainer from "../src/do/index";
import { defineContainer } from "../src/index";

/** Minimal fake of the pieces `@cloudflare/containers` reads off the DO ctx. */
const fakeDurableObjectContext = (): Record<string, unknown> => {
    return {
        // The base ctor schedules alarms inside an un-awaited
        // `blockConcurrencyWhile(...)` critical section that touches the full
        // workerd storage surface. We're unit-testing field application (which
        // happens synchronously, outside this block), so we accept the callback
        // but don't run it — otherwise the alarm machinery becomes an unhandled
        // rejection that fails the run.
        blockConcurrencyWhile: async () => {},
        container: { running: false },
        storage: {
            deleteAlarm: async () => {},
            get: async () => undefined,
            getAlarm: async () => null,
            kv: {
                delete: () => {},
                get: () => undefined,
                put: () => {},
            },
            put: async () => {},
            setAlarm: async () => {},
            sql: {
                // The base class iterates exec() results, so return an (empty)
                // iterable carrying the cursor helpers it may reach for.
                exec: () => Object.assign([], { one: () => undefined, raw: () => [], toArray: () => [] }),
            },
        },
    };
};

describe(CirrusContainer, () => {
    it("applies the definition onto the Container base", () => {
        expect.assertions(4);

        const definition = defineContainer({
            defaultPort: 8080,
            enableInternet: false,
            env: { LOG_LEVEL: "info" },
            image: "./containers/transcoder",
            secrets: ["API_KEY"],
            sleepAfter: "5m",
        });

        const instance = new CirrusContainer(fakeDurableObjectContext() as never, { API_KEY: "s3cret" }, definition, "transcoder") as unknown as {
            defaultPort?: number;
            enableInternet: boolean;
            envVars: Record<string, string>;
            sleepAfter: number | string;
        };

        expect(instance.defaultPort).toBe(8080);
        expect(instance.sleepAfter).toBe("5m");
        expect(instance.enableInternet).toBe(false);
        expect(instance.envVars).toStrictEqual({ API_KEY: "s3cret", LOG_LEVEL: "info" });
    });

    it("fails fast when a declared secret is missing from the worker env", () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secrets: ["API_KEY"] });

        expect(() => new CirrusContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder")).toThrow('declared secret "API_KEY" is not set');
    });
});

describe("cirrusContainer lifecycle logging", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const build = (): InstanceType<typeof CirrusContainer> => {
        const definition = defineContainer({ image: "./app" });

        return new CirrusContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder");
    };

    it("emits a cirrus container event on start", async () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await build().onStart();

        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({
            container: "transcoder",
            event: "start",
            source: "cirrus",
            type: "container",
        });
    });

    it("emits on stop with the exit reason", async () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await build().onStop({ exitCode: 137, reason: "runtime_signal" });

        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({ event: "stop", message: "runtime_signal (exit 137)" });
    });

    it("emits an error event and re-throws (the base onError contract)", () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "error").mockImplementation(() => {});

        expect(() => build().onError(new Error("crashed"))).toThrow("crashed");
        expect(JSON.parse((spy.mock.calls[0]![0] as string) ?? "{}")).toMatchObject({ event: "error", level: "error", message: "crashed" });
    });
});
