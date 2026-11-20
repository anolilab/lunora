/**
 * Account-level "central runtime" stand-in (spike H1b/H2). Exports a DO class
 * (so a namespaced tenant can try a cross-script `script_name` binding at it)
 * and a callback driver that executes N chained calls into a tenant script
 * through the dispatch namespace — the round-trip whose cost decides whether
 * a callback-thin architecture is viable.
 */

interface UserWorkerStub {
    fetch: (request: Request) => Promise<Response>;
}

interface DispatchNamespace {
    get: (name: string) => UserWorkerStub;
}

interface Env {
    DISPATCHER: DispatchNamespace;
}

/** The DO a tenant may try to bind cross-script (H1). Trivial state echo. */
export class PlatformShardDO {
    private count = 0;

    async fetch(): Promise<Response> {
        this.count += 1;

        return Response.json({ count: this.count, owner: "platform" });
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // H2: /callback?tenant=<script>&hops=<n> — chain N sequential calls into
        // the tenant (one per simulated ctx.db op) and report total + per-hop ms.
        if (url.pathname === "/callback") {
            const tenant = url.searchParams.get("tenant") ?? "";
            const hops = Number.parseInt(url.searchParams.get("hops") ?? "1", 10);

            if (!tenant || !Number.isInteger(hops) || hops < 1 || hops > 100) {
                return Response.json({ error: "tenant and hops (1-100) required" }, { status: 400 });
            }

            const stub = env.DISPATCHER.get(tenant);
            const started = Date.now();

            for (let index = 0; index < hops; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: each hop models one dependent ctx.db op
                const response = await stub.fetch(new Request(`https://tenant.internal/execute?op=${String(index)}`));

                if (!response.ok) {
                    return Response.json({ error: `hop ${String(index)} failed (${String(response.status)})` }, { status: 502 });
                }
            }

            const totalMs = Date.now() - started;

            return Response.json({ hops, perHopMs: totalMs / hops, totalMs });
        }

        return new Response("platform-runtime spike worker", { status: 200 });
    },
};
