/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * `ctx.services` against real service bindings (plan 457): the same
 * `createServices` + `LUNORA_SERVICES` shape the generated shard builds, over
 * a fetch Worker and a `WorkerEntrypoint` RPC Worker running beside the test
 * Worker in workerd. Covers what the Node suite cannot: a real `Fetcher`
 * (whose `fetch` needs its `this`) and a real RPC stub.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ServiceBindingSpec, ServiceFetcher, ServiceRpc } from "../../src/services";
import { createServices } from "../../src/services";

/** The RPC surface the `gateway` auxiliary Worker exports (see `vitest.config.ts`). */
declare class Gateway {
    public complete(prompt: string): Promise<string>;
}

interface Services {
    gateway: ServiceRpc<typeof Gateway>;
    parser: ServiceFetcher;
}

const SPECS: ReadonlyArray<ServiceBindingSpec> = [
    { binding: "SERVICE_GATEWAY", name: "gateway", rpc: true },
    { binding: "SERVICE_PARSER", name: "parser" },
];

const services = (): Services => createServices(env as unknown as Record<string, unknown>, SPECS) as unknown as Services;

describe("ctx.services (workerd)", () => {
    it("calls a fetch service through its binding", async () => {
        expect.assertions(1);

        const response = await services().parser.fetch("https://parser/documents/1");

        await expect(response.text()).resolves.toBe("parsed /documents/1");
    });

    it("hands a fetch service's fetch to a client detached", async () => {
        expect.assertions(1);

        // The documented pattern: `fetch: ctx.services.parser.fetch`. An unbound
        // `Fetcher.fetch` throws "Illegal invocation" in workerd.
        const client = { fetch: services().parser.fetch };
        const response = await client.fetch("https://parser/detached");

        await expect(response.text()).resolves.toBe("parsed /detached");
    });

    it("hands an RPC service's fetch to a client detached", async () => {
        expect.assertions(1);

        const client = { fetch: services().gateway.fetch };
        const response = await client.fetch("https://gateway/detached");

        await expect(response.text()).resolves.toBe("gateway /detached");
    });

    it("calls a WorkerEntrypoint method over RPC", async () => {
        expect.assertions(1);

        await expect(services().gateway.complete("hello")).resolves.toBe("completed hello");
    });
});
