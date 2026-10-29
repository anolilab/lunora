/**
 * Test entry-point Worker for the `@lunora/browser` workerd suite.
 *
 * {@link FakeBrowserRun} stands in for the Browser Run binding at its own
 * boundary. `env.BROWSER` is a real workerd service binding to it, so every call
 * crosses the same kind of edge the real binding does: `fetch` for the HTTP
 * contract `@cloudflare/playwright` speaks, and an RPC method for `quickAction`.
 * It answers what a browser-less fake can answer honestly:
 *
 * an acquire (`POST /v1/devtools/browser`) gets a session id, `GET /v1/sessions`
 * one live session, and the DevTools WebSocket upgrade a 503, because there is no
 * Chrome behind it to speak CDP. Everything past that upgrade (page navigation,
 * screenshots, PDF) is what this suite cannot reach.
 *
 * Every request and RPC is recorded, and read back over RPC, so the tests assert
 * on what actually reached the binding.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

interface RecordedCall {
    /** The JSON body of an HTTP call, or the RPC arguments of `quickAction`. */
    body?: unknown;
    /** `cf-brapi-guardrails`, the header `@cloudflare/playwright` puts guardrails in on an upgrade. */
    guardrailsHeader?: string;
    kind: "fetch" | "quickAction";
    method?: string;
    /** Path plus query of an HTTP call. */
    path?: string;
    upgrade?: string;
}

/** Module scope: survives across the per-call entrypoint instances, cleared by `reset()`. */
const calls: RecordedCall[] = [];

const SESSION_ID = "fake-session-1";

/* eslint-disable class-methods-use-this -- workerd dispatches RPC to instance methods, and an entrypoint instance lives for one call, so the log has to be module state. */
class FakeBrowserRun extends WorkerEntrypoint {
    public override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const text = await request.text();

        calls.push({
            body: text === "" ? undefined : (JSON.parse(text) as unknown),
            guardrailsHeader: request.headers.get("cf-brapi-guardrails") ?? undefined,
            kind: "fetch",
            method: request.method,
            path: `${url.pathname}${url.search}`,
            upgrade: request.headers.get("upgrade") ?? undefined,
        });

        if (request.headers.get("upgrade") === "websocket") {
            return new Response("no Chrome behind this fake binding", { status: 503 });
        }

        if (request.method === "POST" && url.pathname === "/v1/devtools/browser") {
            return Response.json({ sessionId: SESSION_ID });
        }

        if (url.pathname === "/v1/sessions") {
            return Response.json({ sessions: [{ sessionId: SESSION_ID, startTime: 1 }] });
        }

        return new Response("not found", { status: 404 });
    }

    public quickAction(action: string, options: Record<string, unknown>): Response {
        calls.push({ body: { action, options }, kind: "quickAction" });

        return Response.json({ result: { action, url: options["url"] }, success: true });
    }

    public recorded(): RecordedCall[] {
        return calls;
    }

    public reset(): void {
        calls.length = 0;
    }
}
/* eslint-enable class-methods-use-this */

interface TestEnv {
    BROWSER: Fetcher & {
        quickAction: (action: string, options: { url: string }) => Promise<Response>;
        recorded: () => Promise<RecordedCall[]>;
        reset: () => Promise<void>;
    };
}

const testWorker = {
    fetch: (): Response => new Response("lunora-browser-test-worker"),
};

export default testWorker;
export type { RecordedCall, TestEnv };
export { FakeBrowserRun, SESSION_ID };
