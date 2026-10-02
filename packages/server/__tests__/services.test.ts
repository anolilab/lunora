import { describe, expect, expectTypeOf, it } from "vitest";

import type { ServiceFetcher, ServiceRpc } from "../src/services";
import { createServices } from "../src/services";

class Gateway {
    public readonly env: unknown = {};

    public complete(prompt: string): string {
        return `${String(this.env)}${prompt}`;
    }

    public async embed(text: string): Promise<number[]> {
        return [text.length, Object.keys(this).length];
    }
}

describe("createServices", () => {
    it("resolves each declared service off env by its binding", async () => {
        expect.assertions(1);

        const gateway = { complete: async () => "done" };
        const resolved = createServices({ SERVICE_GATEWAY: gateway }, [{ binding: "SERVICE_GATEWAY", name: "gateway", rpc: true }]).gateway as typeof gateway;

        await expect(resolved.complete()).resolves.toBe("done");
    });

    it("binds an RPC service's fetch too, so it can be passed to a client detached", async () => {
        expect.assertions(2);

        const gateway = {
            label: "gateway",
            async fetch(this: { label: string }): Promise<Response> {
                return new Response(this.label);
            },
        };
        const resolved = createServices({ SERVICE_GATEWAY: gateway }, [{ binding: "SERVICE_GATEWAY", name: "gateway", rpc: true }]).gateway as ServiceFetcher;
        const { fetch } = resolved;

        await expect(fetch("https://gateway/").then(async (response) => response.text())).resolves.toBe("gateway");
        // One bound function per service, not a fresh one per read.
        expect(resolved.fetch).toBe(fetch);
    });

    it("hands a fetch service over with fetch bound, so it can be passed to a client detached", async () => {
        expect.assertions(1);

        const parser = {
            label: "parsed",
            async fetch(this: { label: string }): Promise<Response> {
                return new Response(this.label);
            },
        };
        const { fetch } = createServices({ SERVICE_PARSER: parser }, [{ binding: "SERVICE_PARSER", name: "parser" }]).parser as ServiceFetcher;

        await expect(fetch("https://parser/").then(async (response) => response.text())).resolves.toBe("parsed");
    });

    it("can be awaited when unbound without throwing", async () => {
        expect.assertions(1);

        const { parser } = createServices({}, [{ binding: "SERVICE_PARSER", name: "parser" }]);

        await expect(Promise.resolve(parser)).resolves.toBeDefined();
    });

    it("throws on first use of an unbound service, naming its binding", () => {
        expect.assertions(1);

        const services = createServices({}, [{ binding: "SERVICE_PARSER", name: "parser" }]) as { parser: { fetch: unknown } };

        expect(() => services.parser.fetch).toThrow(/ctx\.services\.parser: the "SERVICE_PARSER" service binding is not bound/u);
    });
});

describe("serviceRpc", () => {
    it("turns every entrypoint method into an async call and drops non-methods", () => {
        expect.assertions(0);

        expectTypeOf<ServiceRpc<typeof Gateway>["complete"]>().toEqualTypeOf<(prompt: string) => Promise<string>>();
        expectTypeOf<ServiceRpc<typeof Gateway>["embed"]>().toEqualTypeOf<(text: string) => Promise<number[]>>();
        expectTypeOf<ServiceRpc<typeof Gateway>>().not.toHaveProperty("env");
        expectTypeOf<ServiceRpc<typeof Gateway>>().toHaveProperty("fetch");
    });
});
