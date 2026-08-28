import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/**
 * `ctx.scheduler` inside a `.global()` table's triggers.
 *
 * A global table's `defineTrigger` handlers run inside the D1/Hyperdrive writer,
 * which takes its own `scheduler` option and otherwise substitutes a stub that
 * throws on use. The shard-side factory does nothing for them, so unless the app
 * builder threads the resolved scheduler into the writer too,
 * `ctx.scheduler.runAfter(...)` in a global trigger fails at runtime in an app
 * that has a scheduler wired — and nothing rejects it at build time.
 */

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

/** The writer entry the emitter must produce, parameterised by that backend's options type. */
const schedulerEntry = (optionsType: string): string =>
    `...(this.schedulerDeclaration ? { scheduler: this.resolveScheduler(env) as unknown as ${optionsType}["scheduler"] } : {}),`;

describe("emitApp — scheduler on the .global() writers", () => {
    it("threads the resolved scheduler into the D1 global writer", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasGlobal: true, hasScheduler: true });

        expect(output).toContain(schedulerEntry("D1CtxDbOptions"));
    });

    it("threads the resolved scheduler into the Hyperdrive global writer", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true, hasScheduler: true });

        expect(output).toContain(schedulerEntry("SqlCtxDbOptions"));
    });

    it("emits no scheduler entry — and no resolver — for a global app with no scheduler declared", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).not.toContain("scheduler: this.resolveScheduler(env)");
        expect(output).not.toContain("private resolveScheduler(");
    });

    it("shares one resolver between the shard factory and the global writer", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true, hasScheduler: true });

        expect(output).toContain("private resolveScheduler(env: Env)");
        expect(output).toContain("scheduler: (rawEnv: Record<string, unknown>) => this.resolveScheduler(rawEnv as Env),");
    });
});
