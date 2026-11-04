import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

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

    it("awaits auth before every entry point that can build the worker", () => {
        expect.assertions(6);

        // The worker is built once per isolate and reads `getAuth()` while it builds,
        // so whichever entry point runs first must find auth initialised.
        const output = emitApp({ ...baseOptions, hasAuth: true, hasFramework: true, hasQueue: true });
        const builds = output.split(/worker \?\?= buildWorker\(|\? \(worker \?\?= buildWorker\(/u).slice(0, -1);

        // fetch, scheduled, serverQuery, queue, host email.
        expect(builds).toHaveLength(5);

        const [fetchSegment, scheduledSegment, serverQuerySegment, queueSegment, emailSegment] = builds as [string, string, string, string, string];

        expect(fetchSegment.trimEnd()).toMatch(/await ensureAuth\(env\);$/u);
        expect(serverQuerySegment.trimEnd()).toMatch(/await ensureAuth\(rawEnv as Env\);$/u);

        for (const segment of [scheduledSegment, queueSegment, emailSegment]) {
            expect(segment.trimEnd()).toMatch(/const target = \(await authReady\(rawEnv as Env\)\)$/u);
        }
    });

    it("logs why auth failed when a host-owned event carries on without it", () => {
        expect.assertions(2);

        // Auth retries on every event, so an isolate that only ever sees cron, queue or mail would otherwise
        // repeat the failure indefinitely with nothing in the logs saying why admin and auth are missing.
        const output = emitApp({ ...baseOptions, hasAuth: true, hasFramework: true, hasQueue: true });
        const helper = output.slice(output.indexOf("const authReady"), output.indexOf("const authReady") + 600);

        expect(helper).toMatch(/console\.error\(/u);
        expect(helper).toMatch(/error\)/u);
    });

    it("gives a host-owned event an uncached worker when auth failed to initialise", () => {
        expect.assertions(3);

        // A failed auth init must not take the host's cron/queue/mail down, and must not leave a
        // cached worker that was built without auth.
        const output = emitApp({ ...baseOptions, hasAuth: true, hasFramework: true, hasQueue: true });

        expect(output).toContain("ensureAuth(env).then(");
        expect(output).toContain(": buildWorker(rawEnv as Env, deferred);");
        expect(output).toContain("return target.queue?.(batch, rawEnv, context);");
    });
});
