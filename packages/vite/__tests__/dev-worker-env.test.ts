import { describe, expect, it } from "vitest";

import { createCommandProbe, DEV_WORKER_ENV_VALUE, DEV_WORKER_ENV_VAR, withDevWorkerEnv } from "../src/dev-worker-env";

/** Invoke the composed cloudflare `config` customizer against a worker config and return the (mutated) config. */
const applyCustomizer = (options: Record<string, unknown>, workerConfig: { vars?: Record<string, unknown> }): { vars?: Record<string, unknown> } => {
    const customizer = options.config as (config: { vars?: Record<string, unknown> }) => void;

    customizer(workerConfig);

    return workerConfig;
};

describe("withDevWorkerEnv", () => {
    it("sets WORKER_ENV to development in the worker vars during serve", () => {
        expect.assertions(2);

        const options = withDevWorkerEnv({}, () => true);
        const worker = applyCustomizer(options, {});

        expect(worker.vars?.[DEV_WORKER_ENV_VAR]).toBe(DEV_WORKER_ENV_VALUE);
        expect(DEV_WORKER_ENV_VALUE).toBe("development");
    });

    it("never injects during a production build", () => {
        expect.assertions(1);

        const options = withDevWorkerEnv({}, () => false);
        const worker = applyCustomizer(options, { vars: { EXISTING: "1" } });

        expect(worker.vars).toStrictEqual({ EXISTING: "1" });
    });

    it("does not clobber a user-declared WORKER_ENV", () => {
        expect.assertions(1);

        const options = withDevWorkerEnv({}, () => true);
        const worker = applyCustomizer(options, { vars: { WORKER_ENV: "staging" } });

        expect(worker.vars?.WORKER_ENV).toBe("staging");
    });

    it("preserves a caller-supplied config customizer and still injects", () => {
        expect.assertions(2);

        // Function form that returns a partial (the impl `Object.assign`s it onto the worker config).
        const userConfig = (): { vars: Record<string, unknown> } => {
            return { vars: { USER: "yes" } };
        };
        const options = withDevWorkerEnv({ config: userConfig }, () => true);
        const worker = applyCustomizer(options, {});

        expect(worker.vars?.USER).toBe("yes");
        expect(worker.vars?.[DEV_WORKER_ENV_VAR]).toBe(DEV_WORKER_ENV_VALUE);
    });

    it("merges a caller-supplied partial config object", () => {
        expect.assertions(2);

        const options = withDevWorkerEnv({ config: { vars: { USER: "yes" } } }, () => true);
        const worker = applyCustomizer(options, {});

        expect(worker.vars?.USER).toBe("yes");
        expect(worker.vars?.[DEV_WORKER_ENV_VAR]).toBe(DEV_WORKER_ENV_VALUE);
    });
});

describe("createCommandProbe", () => {
    it("reports serve only after the config hook resolves command to serve", () => {
        expect.assertions(3);

        const { isServe, plugin } = createCommandProbe();

        expect(isServe()).toBe(false);

        const hook = plugin.config as (config: unknown, env: { command: string }) => void;

        hook({}, { command: "serve" });

        expect(isServe()).toBe(true);

        hook({}, { command: "build" });

        expect(isServe()).toBe(false);
    });
});
