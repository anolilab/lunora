/**
 * Namespaced tenant stand-in (spike H1/H2). Answers the platform worker's
 * callback executions (`/execute` — one simulated user-function/db op) and
 * exposes `/do-binding` to test whether its upload metadata's cross-script
 * `durable_objects` binding (H1) actually resolved.
 */

interface DurableObjectId {
    toString: () => string;
}

interface DurableObjectStub {
    fetch: (request: Request) => Promise<Response>;
}

interface DurableObjectNamespaceLike {
    get: (id: DurableObjectId) => DurableObjectStub;
    idFromName: (name: string) => DurableObjectId;
}

interface Env {
    /** H1: bound in upload metadata with `script_name` → the platform worker. */
    PLATFORM_SHARD?: DurableObjectNamespaceLike;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // H2 callback target: pretend to run one user-function op.
        if (url.pathname === "/execute") {
            return Response.json({ ok: true, op: url.searchParams.get("op") });
        }

        // H1: does the cross-script DO binding work at all?
        if (url.pathname === "/do-binding") {
            if (!env.PLATFORM_SHARD) {
                return Response.json({ bound: false, error: "PLATFORM_SHARD binding absent" }, { status: 501 });
            }

            try {
                const stub = env.PLATFORM_SHARD.get(env.PLATFORM_SHARD.idFromName("h1-probe"));
                const response = await stub.fetch(new Request("https://do.internal/"));

                return Response.json({ bound: true, upstream: await response.json() });
            } catch (error) {
                return Response.json({ bound: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
            }
        }

        return new Response("thin-tenant spike worker", { status: 200 });
    },
};
