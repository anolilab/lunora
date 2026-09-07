import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { createServiceClient, RPC_PATH } from "../src/service";
import type { FunctionReference } from "../src/types";

/** A `FunctionReference` as codegen emits it — the phantom is types-only. */
const reference = <K extends "action" | "mutation" | "query", A, R>(path: string): FunctionReference<K, A, R> => {
    return { __lunoraRef: path };
};

/** `Request.clone()` is a distinct nominal type under workers-types; name it once rather than cast at every use. */
type RecordedRequest = ReturnType<Request["clone"]>;

/** A service binding stand-in: records the request, replies with `body`. */
const binding = (body: unknown, init: { status?: number } = {}): { calls: RecordedRequest[]; fetch: (request: Request) => Promise<Response> } => {
    const calls: RecordedRequest[] = [];

    return {
        calls,
        fetch: async (request: Request) => {
            calls.push(request.clone());

            return new Response(typeof body === "string" ? body : JSON.stringify(body), {
                headers: { "content-type": "application/json" },
                status: init.status ?? 200,
            });
        },
    };
};

describe("createServiceClient", () => {
    // `encodeWire` rejects any non-plain object (a `RegExp`, a `Headers`, a class
    // instance, one with a working `toJSON()`) where `JSON.stringify` swallowed it
    // into `{}`. Its own message names only the type, so the caller and the target
    // function have to be attached here or the throw is untraceable.
    it("labels an unencodable argument with the surface and the function path", async () => {
        expect.assertions(2);

        const service = binding({ result: null });
        const client = createServiceClient(service);

        await expect(client.query(reference<"query", { pattern: RegExp }, never>("threads:list"), { pattern: /nope/u })).rejects.toThrow(
            /@lunora\/client\/service: cannot encode args for 'threads:list' — /,
        );
        // Rejected before the hop, so the binding is never called.
        expect(service.calls).toHaveLength(0);
    });

    it("posts the RPC envelope the worker route documents", async () => {
        expect.assertions(4);

        const service = binding({ result: [{ id: "1" }] });
        const client = createServiceClient(service);

        const value = await client.query(reference<"query", { limit: number }, { id: string }[]>("threads:list"), { limit: 5 });

        expect(value).toStrictEqual([{ id: "1" }]);

        const request = service.calls[0]!;

        expect(new URL(request.url).pathname).toBe(RPC_PATH);
        expect(request.method).toBe("POST");
        await expect(request.json()).resolves.toStrictEqual({ args: { limit: 5 }, functionPath: "threads:list" });
    });

    it("omits shardKey unless asked, and sends it when given", async () => {
        expect.assertions(2);

        // The callee routes to its default shard when the key is absent — same
        // rule as the HTTP path, so sending an explicit `undefined` would be a
        // different (and wrong) statement.
        const withoutKey = binding({ result: null });

        await createServiceClient(withoutKey).query(reference<"query", undefined, null>("threads:list"));

        await expect(withoutKey.calls[0]!.json()).resolves.toStrictEqual({ args: {}, functionPath: "threads:list" });

        const withKey = binding({ result: null });

        await createServiceClient(withKey).query(reference<"query", undefined, null>("threads:list"), undefined, { shardKey: "tenant-7" });

        await expect(withKey.calls[0]!.json()).resolves.toStrictEqual({ args: {}, functionPath: "threads:list", shardKey: "tenant-7" });
    });

    it("wire-encodes a bigint argument instead of throwing on JSON.stringify", async () => {
        expect.assertions(2);

        // Plain JSON cannot carry a `bigint` — `JSON.stringify` throws on one. The
        // HTTP client wire-encodes every argument for exactly this reason, and a
        // service binding is the same wire; skipping it would make the money path
        // fail (or silently truncate) only over bindings.
        const service = binding({ result: "ok" });

        await createServiceClient(service).mutation(reference<"mutation", { cents: bigint }, string>("billing:charge"), { cents: 9_007_199_254_740_993n });

        const body: { args: { cents: unknown } } = await service.calls[0]!.json();

        expect(body.args.cents).toBeDefined();
        expect(JSON.stringify(body.args.cents)).toContain("9007199254740993");
    });

    it("decodes a wire-encoded result back to its real type", async () => {
        expect.assertions(1);

        // The inverse of the above: a `bigint` RETURN must arrive as a bigint, not
        // as the codec's tagged envelope. The fixture is produced BY the codec
        // rather than hand-written, so the test cannot drift from the tag format.
        const service = binding({ result: encodeWire(42n) });

        const value = await createServiceClient(service).query(reference<"query", undefined, bigint>("billing:total"));

        expect(value).toBe(42n);
    });

    it("rethrows the worker's error envelope with its code", async () => {
        expect.assertions(2);

        // A caller across a binding should see the same `.code` it would see
        // calling the function in-process — otherwise every cross-worker call
        // needs its own error mapping.
        const service = binding({ error: { code: "NOT_FOUND", message: "no such thread" } }, { status: 404 });

        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:get"))).rejects.toThrow("no such thread");
        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:get"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("says the binding may be pointed at the wrong Worker when the reply is not JSON", async () => {
        expect.assertions(1);

        // The likeliest first-run mistake, and the status alone sends people
        // hunting through the callee's handlers instead of their wrangler config.
        const service = binding("<!doctype html><h1>Not Found</h1>", { status: 404 });

        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:list"))).rejects.toThrow(/service binding points at/u);
    });

    it("preserves hint and docsUrl, not just code", async () => {
        expect.assertions(2);

        // These come from the error catalog and are what make a failure
        // actionable; restoring only `code`/`data` would give a service-binding
        // caller a weaker error than the same function throws over HTTP.
        const service = binding(
            { error: { code: "NOT_FOUND", docsUrl: "https://lunora.dev/e/not-found", hint: "check the id", message: "nope" } },
            { status: 404 },
        );

        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:get"))).rejects.toMatchObject({ hint: "check the id" });
        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:get"))).rejects.toMatchObject({
            docsUrl: "https://lunora.dev/e/not-found",
        });
    });

    it("reports a JSON body that is not an object instead of crashing on it", async () => {
        expect.assertions(2);

        // `response.json()` resolves `null` for `null` and a scalar for `4`, on
        // either of which `"error" in parsed` throws `TypeError: Cannot use 'in'
        // operator` — burying the real cause under an unrelated crash.
        await expect(createServiceClient(binding("null")).query(reference<"query", undefined, null>("threads:list"))).rejects.toThrow(/not an object/u);
        await expect(createServiceClient(binding("4")).query(reference<"query", undefined, null>("threads:list"))).rejects.toThrow(/not an object/u);
    });

    it("does not swallow a non-2xx that carried no error envelope", async () => {
        expect.assertions(1);

        // A JSON body with neither `error` nor a meaningful `result` would
        // otherwise be returned as a successful `undefined`.
        const service = binding({ unexpected: true }, { status: 502 });

        await expect(createServiceClient(service).query(reference<"query", undefined, null>("threads:list"))).rejects.toThrow(/502/u);
    });

    it("passes the binding's own fetch, not the global one", async () => {
        expect.assertions(1);

        // The whole point: dispatch goes in-process to the sibling Worker. A
        // regression here would silently start making real network calls.
        const globalFetch = vi.spyOn(globalThis, "fetch");
        const service = binding({ result: null });

        await createServiceClient(service).query(reference<"query", undefined, null>("threads:list"));

        expect(globalFetch).not.toHaveBeenCalled();

        globalFetch.mockRestore();
    });
});
