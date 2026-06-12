import { describe, expect, it } from "vitest";

import { createServerClient, deserializePreloaded, getServerSession, preloadedQueryResult, preloadQuery, serializePreloaded } from "../../src/ssr/index";

describe("@cirrus/client/ssr public surface", () => {
    it("exposes the re-exported and own helpers as callable functions", () => {
        expect(typeof createServerClient).toBe("function");
        expect(typeof getServerSession).toBe("function");
        expect(typeof preloadQuery).toBe("function");
        expect(typeof preloadedQueryResult).toBe("function");
        expect(typeof serializePreloaded).toBe("function");
        expect(typeof deserializePreloaded).toBe("function");
    });

    it("createServerClient builds a request-scoped client with the given url", () => {
        const client = createServerClient({ url: "https://app.example.workers.dev" });

        expect(client.url).toBe("https://app.example.workers.dev");
    });

    it("preloadedQueryResult reads the value out of a Preloaded token", () => {
        const value = preloadedQueryResult({
            __cirrusPreloaded: true,
            args: {},
            functionPath: "f:g",
            value: 42,
        });

        expect(value).toBe(42);
    });
});
