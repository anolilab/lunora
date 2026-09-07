import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

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
    hasKvIntrospector: false,
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

describe("emitApp — framework-host trigger passthrough", () => {
    it("exposes `queue` on a framework-hosted app even with no push queues of its own", () => {
        expect.assertions(2);

        // `withFrameworkWorker` hands the host's own `queue` back out of the
        // composed worker; without the key on `composed`, wrangler never sees it —
        // and on workerd an unserved consumer implicitly acks and destroys the batch.
        const output = emitApp({ ...baseOptions, hasFramework: true });

        expect(output).toContain("queue: async (batch: unknown, rawEnv: unknown, context: ExecutionContextLike): Promise<void> =>");
        expect(output).toContain("return worker.queue?.(batch, rawEnv, context);");
    });

    it("leaves a standalone queue-free app's module shape unchanged", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions });

        expect(output).not.toContain("worker.queue?.(batch, rawEnv, context)");
    });

    it("forwards the framework host's own `email` when the app registered none", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasFramework: true });

        expect(output).toContain('typeof host.email === "function"');
        expect(output).toContain("return worker.email?.(message, rawEnv, context) ?? Promise.resolve();");
    });

    it("emits no host-email passthrough for a standalone app, which has no host", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions });

        expect(output).not.toContain("typeof host.email");
    });
});
