import { describe, expect, it, vi } from "vitest";

import { loadStudioDocument } from "../src/studio-documents";

/** An assets binding that answers every request with `response` and records the URLs it was asked for. */
const binding = (response: () => Response): { fetch: (request: Request) => Promise<Response>; urls: string[] } => {
    const urls: string[] = [];

    return {
        fetch: vi.fn<(request: Request) => Promise<Response>>(async (request) => {
            urls.push(request.url);

            return response();
        }),
        urls,
    };
};

describe(loadStudioDocument, () => {
    it("reads the document from its fixed path on the binding", async () => {
        expect.assertions(2);

        const assets = binding(() => Response.json({ openapi: "3.1.0" }));

        await expect(loadStudioDocument(assets, "openapi")).resolves.toStrictEqual({ openapi: "3.1.0" });
        expect(assets.urls).toStrictEqual(["https://lunora-studio.invalid/_lunora/studio/openapi.json"]);
    });

    it("answers undefined when the binding does not hold the file", async () => {
        expect.assertions(1);

        await expect(
            loadStudioDocument(
                binding(() => new Response("Not Found", { status: 404 })),
                "architecture",
            ),
        ).resolves.toBeUndefined();
    });

    it("refuses a single-page app's shell, which the binding answers a missing file with", async () => {
        expect.assertions(1);

        const shell = binding(() => new Response("<!doctype html>", { headers: { "content-type": "text/html" }, status: 200 }));

        await expect(loadStudioDocument(shell, "openrpc")).resolves.toBeUndefined();
    });

    it("answers undefined when the binding rejects, and asks again on the next read", async () => {
        expect.assertions(3);

        let calls = 0;
        const flaky = {
            fetch: vi.fn<(request: Request) => Promise<Response>>(async () => {
                calls += 1;

                if (calls === 1) {
                    throw new Error("assets binding unavailable");
                }

                return Response.json({ openapi: "3.1.0" });
            }),
        };

        await expect(loadStudioDocument(flaky, "openapi")).resolves.toBeUndefined();
        await expect(loadStudioDocument(flaky, "openapi")).resolves.toStrictEqual({ openapi: "3.1.0" });
        expect(flaky.fetch).toHaveBeenCalledTimes(2);
    });

    it("answers undefined for a JSON document that does not parse", async () => {
        expect.assertions(1);

        const truncated = binding(() => new Response('{"openapi": "3.1', { headers: { "content-type": "application/json" }, status: 200 }));

        await expect(loadStudioDocument(truncated, "openapi")).resolves.toBeUndefined();
    });

    it.each([undefined, null, {}, "ASSETS"])("answers undefined without a binding (%s)", async (missing) => {
        expect.assertions(1);

        await expect(loadStudioDocument(missing, "openapi")).resolves.toBeUndefined();
    });
});
