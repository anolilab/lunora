/**
 * Spike tenant Worker (CLOUD-PLAN.md §6 risk #3) — a minimal hibernatable-
 * WebSocket Durable Object, mirroring the exact Cloudflare primitive `@lunora/do`'s
 * `ShardDO` uses for subscriptions (`state.acceptWebSocket` + the
 * `webSocketMessage`/`webSocketClose` hibernation handlers). Deployed INTO a
 * Workers-for-Platforms dispatch namespace so the spike can drive it through the
 * cloud dispatcher's `env.DISPATCHER.get(script).fetch(...)`.
 *
 * It is intentionally framework-free (no Cirrus runtime) so the spike validates
 * the WfP × DO-hibernation × per-invocation-limits primitives in isolation. The
 * `probe.mjs` script exercises three things end-to-end through the dispatcher:
 *   1. a WebSocket UPGRADE survives the dispatch hop (101 + live socket),
 *   2. a hibernated message handler runs and a server push (broadcast) is
 *      delivered to the socket — the "mutation → subscription" shape,
 *   3. per-invocation CPU limits (`/burn`) behave as configured by the
 *      dispatcher's `{ limits: { cpuMs } }`.
 *
 * Routes (all reached via `https://<script>.<appDomain>/...` through the dispatcher):
 *   GET  /ws         → hibernatable WebSocket upgrade
 *   POST /broadcast  → push a message to every open socket (models a mutation)
 *   GET  /burn?ms=N  → busy-loop N ms of CPU (probes the cpuMs limit)
 *
 * Deploy + run: see README.md.
 */

/* eslint-disable */
// @ts-nocheck — standalone deployable; typechecked via its own wrangler/tsc, not the app build.

export class WsRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/ws") {
            if (request.headers.get("Upgrade") !== "websocket") {
                return new Response("expected websocket upgrade", { status: 426 });
            }

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);

            // Hibernatable accept: the DO can be evicted between frames and is
            // re-instantiated to run webSocketMessage on the next frame.
            this.state.acceptWebSocket(server);

            return new Response(null, { status: 101, webSocket: client });
        }

        if (url.pathname === "/broadcast" && request.method === "POST") {
            const body = await request.text();
            const sockets = this.state.getWebSockets();
            const message = JSON.stringify({ at: Date.now(), payload: body, type: "push" });

            for (const ws of sockets) {
                ws.send(message);
            }

            return Response.json({ delivered: sockets.length });
        }

        if (url.pathname === "/burn") {
            const ms = Number(url.searchParams.get("ms") ?? "0");
            const end = Date.now() + ms;
            let iterations = 0;

            while (Date.now() < end) {
                iterations += 1;
            }

            return Response.json({ burnedMs: ms, iterations });
        }

        return new Response("not found", { status: 404 });
    }

    // Hibernation handler: invoked per inbound frame, even after eviction.
    async webSocketMessage(ws, message) {
        const text = typeof message === "string" ? message : "<binary>";

        ws.send(JSON.stringify({ at: Date.now(), echo: text, type: "echo" }));
    }

    async webSocketClose(ws, code) {
        try {
            ws.close(code);
        } catch {
            // socket already closing
        }
    }
}

export default {
    async fetch(request, env) {
        // One shared room for the spike (a single DO instance).
        const id = env.WS_DO.idFromName("spike-room");

        return env.WS_DO.get(id).fetch(request);
    },
};
