import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiOperation } from "../../../../src/features/api/openapi/openapi-model";
import { restDispatch } from "../../../../src/features/api/openapi/run-context";

const operation: ApiOperation = {
    httpPath: "/api/health",
    key: "/api/health#get",
    method: "GET",
    operationId: "getHealth",
    responses: [],
    summary: "",
    tags: [],
    title: "getHealth",
};

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
});
