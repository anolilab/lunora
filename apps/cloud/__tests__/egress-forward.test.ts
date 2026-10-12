import { describe, expect, it } from "vitest";

import { forwardWithEgress, MAX_EGRESS_REDIRECTS } from "../src/egress/forward";
import type { EgressPolicy } from "../src/egress/policy";
import { API, recordingUpstream, redirect, scriptedUpstream } from "./_helpers/egress";

/**
 * Outbound enforcement (plan 477 §3, §4.3–4.4), against an injected fake fetch.
 * One test per rule; no network is touched.
 */

const enforce = (...origins: string[]): EgressPolicy => {
    return { mode: "enforce", origins, v: 1 };
};

describe(forwardWithEgress, () => {
    it("denies a disallowed origin with the 403 body and never calls fetch", async () => {
        const upstream = scriptedUpstream();
        const response = await forwardWithEgress(new Request("https://evil.example.net/steal"), enforce(API), upstream);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_denied", origin: "https://evil.example.net" });
        expect(upstream).not.toHaveBeenCalled();
    });

    it("forwards an allowed request unchanged in method, headers and body", async () => {
        const seen: { body: string; headers: null | string; method: string; url: string }[] = [];
        const upstream = recordingUpstream(async (_hop, request) => {
            seen.push({ body: await request.text(), headers: request.headers.get("x-trace"), method: request.method, url: request.url });

            return new Response("upstream", { status: 201 });
        });

        const response = await forwardWithEgress(
            new Request(`${API}/charges`, { body: "amount=5", headers: { "x-trace": "abc" }, method: "POST" }),
            enforce(API),
            upstream,
        );

        expect(response.status).toBe(201);
        expect(seen).toStrictEqual([{ body: "amount=5", headers: "abc", method: "POST", url: `${API}/charges` }]);
    });

    it("stops a redirect whose Location is a denied origin, at that hop", async () => {
        const upstream = scriptedUpstream(redirect("https://evil.example.net/collect"));
        const response = await forwardWithEgress(new Request(`${API}/start`), enforce(API), upstream);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_denied", origin: "https://evil.example.net" });
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it("walks allowed redirects with redirect manual on every hop", async () => {
        const upstream = scriptedUpstream(redirect("https://cdn.example.com/a"), redirect("/b"), new Response("done", { status: 200 }));
        const response = await forwardWithEgress(new Request(`${API}/start`), enforce(API, "https://cdn.example.com"), upstream);

        expect(response.status).toBe(200);
        expect(upstream).toHaveBeenCalledTimes(3);
        expect(upstream.mock.calls.map(([request]) => request.url)).toStrictEqual([`${API}/start`, "https://cdn.example.com/a", "https://cdn.example.com/b"]);
        expect(upstream.mock.calls.every(([request]) => request.redirect === "manual")).toBe(true);
    });

    it("follows exactly the maximum number of redirects, then stops", async () => {
        const chain = Array.from({ length: MAX_EGRESS_REDIRECTS }, (_, index) => redirect(`${API}/${String(index)}`));
        const upstream = scriptedUpstream(...chain, new Response("final", { status: 200 }));
        const response = await forwardWithEgress(new Request(`${API}/start`), enforce(API), upstream);

        expect(response.status).toBe(200);
        expect(upstream).toHaveBeenCalledTimes(MAX_EGRESS_REDIRECTS + 1);
    });

    it("refuses a redirect past the hop cap", async () => {
        const chain = Array.from({ length: MAX_EGRESS_REDIRECTS + 2 }, (_, index) => redirect(`${API}/${String(index)}`));
        const upstream = scriptedUpstream(...chain);
        const response = await forwardWithEgress(new Request(`${API}/start`), enforce(API), upstream);

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_redirect_limit", max: MAX_EGRESS_REDIRECTS });
        expect(upstream).toHaveBeenCalledTimes(MAX_EGRESS_REDIRECTS + 1);
    });

    it("returns a tenant's manual redirect unchanged when its Location is allowed", async () => {
        const upstream = scriptedUpstream(redirect(`${API}/next`));
        const response = await forwardWithEgress(new Request(`${API}/start`, { redirect: "manual" }), enforce(API), upstream);

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`${API}/next`);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it("refuses a tenant's manual redirect whose Location is denied", async () => {
        const upstream = scriptedUpstream(redirect("https://evil.example.net/x"));
        const response = await forwardWithEgress(new Request(`${API}/start`, { redirect: "manual" }), enforce(API), upstream);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_denied", origin: "https://evil.example.net" });
    });

    it("drops the body headers when a redirect turns the method into GET", async () => {
        const upstream = scriptedUpstream(redirect(`${API}/b`, 303));

        await forwardWithEgress(
            new Request(`${API}/a`, {
                body: "payload",
                headers: { "content-length": "7", "content-type": "text/plain", cookie: "s=1" },
                method: "POST",
            }),
            enforce(API),
            upstream,
        );

        expect(upstream.mock.calls.map(([request]) => request.headers.get("content-length"))).toStrictEqual(["7", null]);
        expect(upstream.mock.calls.map(([request]) => request.headers.get("content-type"))).toStrictEqual(["text/plain", null]);
        expect(upstream.mock.calls.map(([request]) => request.headers.get("cookie"))).toStrictEqual(["s=1", "s=1"]);
    });

    it("turns a 303 into a body-less GET", async () => {
        const seen: { body: string; method: string }[] = [];
        const upstream = recordingUpstream(async (hop, request) => {
            seen.push({ body: await request.text(), method: request.method });

            return hop === 0 ? redirect(`${API}/b`, 303) : new Response("ok", { status: 200 });
        });

        await forwardWithEgress(new Request(`${API}/a`, { body: "payload", method: "POST" }), enforce(API), upstream);

        expect(seen).toStrictEqual([
            { body: "payload", method: "POST" },
            { body: "", method: "GET" },
        ]);
    });

    it("returns a 307 to the tenant rather than replaying a streamed body", async () => {
        const upstream = scriptedUpstream(redirect(`${API}/b`, 307));
        const response = await forwardWithEgress(new Request(`${API}/a`, { body: "payload", method: "POST" }), enforce(API), upstream);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(`${API}/b`);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it("returns a PUT's 301 to the tenant rather than replaying its streamed body", async () => {
        const upstream = scriptedUpstream(redirect(`${API}/b`, 301));
        const response = await forwardWithEgress(new Request(`${API}/a`, { body: "payload", method: "PUT" }), enforce(API), upstream);

        expect(response.status).toBe(301);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it("checks the Location of a 307 with a streamed body before returning it", async () => {
        const upstream = scriptedUpstream(redirect("https://evil.example.net/b", 307));
        const response = await forwardWithEgress(new Request(`${API}/a`, { body: "payload", method: "POST" }), enforce(API), upstream);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toStrictEqual({ error: "egress_denied", origin: "https://evil.example.net" });
    });

    it("replays nothing when a bodiless 307 is followed, and keeps its method", async () => {
        const upstream = scriptedUpstream(redirect(`${API}/b`, 307));
        const response = await forwardWithEgress(new Request(`${API}/a`, { method: "DELETE" }), enforce(API), upstream);

        expect(response.status).toBe(200);
        expect(upstream.mock.calls.map(([request]) => request.method)).toStrictEqual(["DELETE", "DELETE"]);
    });

    it.each([
        { from: "HEAD", status: 303, to: "HEAD" },
        { from: "GET", status: 303, to: "GET" },
        { from: "POST", status: 303, to: "GET" },
        { from: "PUT", status: 303, to: "GET" },
        { from: "POST", status: 301, to: "GET" },
        { from: "POST", status: 302, to: "GET" },
        { from: "PUT", status: 301, to: "PUT" },
        { from: "PATCH", status: 302, to: "PATCH" },
        { from: "DELETE", status: 302, to: "DELETE" },
    ])("follows a $status from $from as $to (fetch spec)", async ({ from, status, to }) => {
        const upstream = scriptedUpstream(redirect(`${API}/b`, status));

        await forwardWithEgress(new Request(`${API}/a`, { method: from }), enforce(API), upstream);

        expect(upstream.mock.calls.map(([request]) => request.method)).toStrictEqual([from, to]);
    });

    it("streams the body to an allowed origin without buffering it first", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(encoder.encode("first;"));
                await gate;
                controller.enqueue(encoder.encode("second"));
                controller.close();
            },
        });
        // If the forwarder buffered the body, the first chunk would never reach the
        // upstream fetch, because `gate` only opens once the upstream has read it.
        const upstream = recordingUpstream(async (_hop, request) => {
            if (request.body === null) {
                throw new Error("expected a streamed body");
            }

            const reader = request.body.getReader();
            const decoder = new TextDecoder();
            const first = await reader.read();

            release();

            const readRest = async (text: string): Promise<string> => {
                const next = await reader.read();

                return next.done ? text : readRest(text + decoder.decode(next.value));
            };

            return new Response(await readRest(decoder.decode(first.value)), { status: 200 });
        });

        const response = await forwardWithEgress(new Request(`${API}/upload`, { body, duplex: "half", method: "POST" } as RequestInit), enforce(API), upstream);

        await expect(response.text()).resolves.toBe("first;second");
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it("drops credentials when a redirect crosses to another allowed origin", async () => {
        const upstream = scriptedUpstream(redirect("https://cdn.example.com/b"));

        await forwardWithEgress(new Request(`${API}/a`, { headers: { authorization: "Bearer t" } }), enforce(API, "https://cdn.example.com"), upstream);

        expect(upstream.mock.calls.map(([request]) => request.headers.get("authorization"))).toStrictEqual(["Bearer t", null]);
    });

    it("passes a redirect-error request through without walking it, and checks its target", async () => {
        const upstream = scriptedUpstream(redirect("https://evil.example.net/x"));
        const response = await forwardWithEgress(new Request(`${API}/start`, { redirect: "error" }), enforce(API), upstream);

        expect(response.status).toBe(403);
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(upstream.mock.calls[0]?.[0].redirect).toBe("error");
    });

    it("forwards to any origin in report mode, and does not walk redirects", async () => {
        const upstream = scriptedUpstream(new Response("ok", { status: 200 }));
        const response = await forwardWithEgress(new Request("https://evil.example.net/x"), { mode: "report", origins: [], v: 1 }, upstream);

        expect(response.status).toBe(200);
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(upstream.mock.calls[0]?.[0].redirect).toBe("follow");
    });

    it("forwards everything when there is no policy", async () => {
        const upstream = scriptedUpstream(new Response("ok", { status: 200 }));
        const request = new Request("https://evil.example.net/x");

        await forwardWithEgress(request, undefined, upstream);

        expect(upstream).toHaveBeenCalledWith(request);
    });
});
