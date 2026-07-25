import { describe, expect, it } from "vitest";

import { createWorkerPlatform } from "../src";

/** A namespace binding double — enough for `createShardDirectory` to resolve. */
const namespace = () => {
    return {
        get: (id: unknown) => {
            return { fetch: async () => new Response(String(id)) };
        },
        idFromName: (name: string) => `id:${name}`,
    };
};

describe("createWorkerPlatform", () => {
    it("carries the Cloudflare capability matrix", () => {
        expect.assertions(1);

        expect(createWorkerPlatform({}).capabilities.id).toBe("cloudflare");
    });

    it("resolves a bound namespace to a shard directory", async () => {
        expect.assertions(1);

        const platform = createWorkerPlatform({ SHARD: namespace() });
        const stub = platform.directory("SHARD").getByName?.("tenant-1");

        await expect(stub?.fetch(new Request("http://localhost/"))).resolves.toBeInstanceOf(Response);
    });

    // A missing namespace is a deploy misconfiguration. Failing here beats
    // surfacing later as a shard that silently cannot be routed to.
    it("throws for an unbound namespace, naming the binding", () => {
        expect.assertions(1);

        expect(() => createWorkerPlatform({}).directory("SHARD")).toThrow(/no Durable Object namespace bound as "SHARD"/);
    });

    it("omits the scheduler when no scheduler wiring is supplied", () => {
        expect.assertions(1);

        expect(createWorkerPlatform({ SHARD: namespace() }).scheduler).toBeUndefined();
    });

    it("builds the scheduler from the default SCHEDULER binding", () => {
        expect.assertions(1);

        const platform = createWorkerPlatform({ SCHEDULER: namespace() }, { scheduler: { originUrl: "https://worker.test" } });

        expect(platform.scheduler?.schedule).toBeDefined();
    });

    // Asking for a scheduler the deployment cannot provide is a configuration
    // error, not something to paper over with a silently absent scheduler.
    it("throws when the scheduler is configured but its binding is absent", () => {
        expect.assertions(1);

        expect(() => createWorkerPlatform({}, { scheduler: { originUrl: "https://worker.test" } })).toThrow(/no Durable Object namespace bound as "SCHEDULER"/);
    });

    it("honours a custom scheduler binding name", () => {
        expect.assertions(1);

        const platform = createWorkerPlatform({ TIMERS: namespace() }, { scheduler: { namespace: "TIMERS", originUrl: "https://worker.test" } });

        expect(platform.scheduler).toBeDefined();
    });

    // Cloudflare crons are declared in wrangler.jsonc and reconciled at build
    // time, so there is no runtime call that could register one. Absence is the
    // contract's signal for that — see `SchedulerHost.cron`.
    it("never exposes runtime cron, because Cloudflare has none", () => {
        expect.assertions(1);

        const platform = createWorkerPlatform({ SCHEDULER: namespace() }, { scheduler: { originUrl: "https://worker.test" } });

        expect(platform.scheduler?.cron).toBeUndefined();
    });
});
