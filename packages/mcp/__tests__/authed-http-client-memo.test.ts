import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthedMcpFetchHandler } from "../src/authed-http";

const constructed = vi.hoisted(() => {
    return { count: 0, listFunctions: 0 };
});

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const original = await importOriginal();

    class CountingClient extends original.LunoraClient {
        public constructor(options: ConstructorParameters<typeof original.LunoraClient>[0]) {
            super(options);
            constructed.count += 1;
        }
    }

    vi.spyOn(CountingClient.prototype, "listFunctions").mockImplementation(async () => {
        constructed.listFunctions += 1;

        return [];
    });

    return { ...original, LunoraClient: CountingClient };
});

const callBody = { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "lunora_list_functions" } };

const post = (): Request =>
    new Request("https://worker.example/mcp", {
        body: JSON.stringify(callBody),
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        method: "POST",
    });

const handlerFor = (tokenFor: (n: number) => string): ((n: number) => Promise<Response>) => {
    let n = 0;
    const handle = createAuthedMcpFetchHandler({
        protect: (handler) => async (request) => await handler(request, { scope: "lunora:read" }),
        server: () => {
            return { token: tokenFor(n), url: "https://api.example.com" };
        },
    });

    return async (next) => {
        n = next;

        return await handle(post());
    };
};

/** Calls 0..last in order, one at a time. */
const callUpTo = async (call: (n: number) => Promise<Response>, last: number): Promise<void> => {
    if (last >= 0) {
        await callUpTo(call, last - 1);
        await call(last);
    }
};

describe("createAuthedMcpFetchHandler client memo", () => {
    beforeEach(() => {
        constructed.count = 0;
        constructed.listFunctions = 0;
    });

    it("reuses one client (and its function-list cache) for identical url and token", async () => {
        expect.assertions(2);

        const call = handlerFor(() => "t");

        await call(0);
        await call(1);

        expect(constructed.count).toBe(1);
        expect(constructed.listFunctions).toBe(1);
    });

    it("builds a client per distinct token", async () => {
        expect.assertions(1);

        const call = handlerFor((n) => `t${String(n % 2)}`);

        await call(0);
        await call(1);
        await call(0);

        expect(constructed.count).toBe(2);
    });

    it("evicts the least recently used client past the cap", async () => {
        expect.assertions(2);

        const call = handlerFor((n) => `t${String(n)}`);

        await callUpTo(call, 256);

        expect(constructed.count).toBe(257);

        await call(0);

        expect(constructed.count).toBe(258);
    });
});
