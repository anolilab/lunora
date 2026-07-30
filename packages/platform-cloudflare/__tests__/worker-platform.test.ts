import { describe, expect, it } from "vitest";

import { createWorkerPlatform } from "../src/platform";

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

    it("passes an injected scheduler host through untouched", () => {
        expect.assertions(1);

        // The scheduler is INJECTED, not constructed: building one needs
        // `@lunora/scheduler` (`createSchedulerHost`), an edge this package
        // deliberately does not take. The factory's whole contract here is
        // identity — whatever host the worker entry built is what callers see.
        const scheduler = {
            cancel: async () => true,
            schedule: async () => {
                return { id: "job-1", scheduledFor: 0 };
            },
        };
        const platform = createWorkerPlatform({ SHARD: namespace() }, { scheduler });

        expect(platform.scheduler).toBe(scheduler);
    });

    // Cloudflare crons are declared in wrangler.jsonc and reconciled at build
    // time, so there is no runtime call that could register one. Absence is the
    // contract's signal for that — and the passthrough must not invent members
    // the injected host does not have: an injected host without `cron` comes
    // out without `cron`.
    it("never exposes runtime cron, because Cloudflare has none", () => {
        expect.assertions(1);

        const scheduler = {
            cancel: async () => true,
            schedule: async () => {
                return { id: "job-1", scheduledFor: 0 };
            },
        };
        const platform = createWorkerPlatform({ SCHEDULER: namespace() }, { scheduler });

        expect(platform.scheduler?.cron).toBeUndefined();
    });
});
