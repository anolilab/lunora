/**
 * Test entry-point Worker for `@lunora/container` workerd integration tests.
 *
 * Mirrors what codegen emits in `_generated/containers.ts` for a project with
 * one `defineContainer` export: a one-line Container DO subclass over the
 * `LunoraContainer` base (`@lunora/container/do`), registered under the
 * wrangler Durable Object class name. The worker's `fetch` also serves a
 * minimal `/_lunora/rpc` endpoint so the container→Lunora bridge client can be
 * driven against a real workerd HTTP round-trip.
 */
import type { Container } from "@cloudflare/containers";

import { defineContainer } from "../../src/define-container";
import { LunoraContainer } from "../../src/do";

interface Env {
    CONTAINER_SMOKE: DurableObjectNamespace<SmokeContainer>;
}

/** The `lunora/containers.ts`-style export under test. */
const smokeContainer = defineContainer({
    defaultPort: 8080,
    env: { GREETING: "hello" },
    image: "./Dockerfile",
    sleepAfter: "5m",
});

/** The generated one-line Container DO subclass, exactly as codegen emits it. */
class SmokeContainer extends LunoraContainer<Env> {
    public constructor(context: ConstructorParameters<typeof Container>[0], env: Env) {
        super(context, env, smokeContainer, "smoke");
    }
}

const testWorker = {
    async fetch(request: Request, _env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Minimal Lunora RPC endpoint double for the container bridge client:
        // success envelope for `smoke:echo`, error envelope for anything else.
        if (url.pathname === "/_lunora/rpc" && request.method === "POST") {
            const body = await request.json<{ args: Record<string, unknown>; functionPath: string }>();

            if (body.functionPath === "smoke:echo") {
                return Response.json({
                    result: {
                        authorization: request.headers.get("authorization"),
                        echoed: body.args,
                    },
                });
            }

            return Response.json({ error: { code: "NOT_FOUND", message: `unknown function "${body.functionPath}"` } }, { status: 404 });
        }

        return new Response("container-test-worker", { status: 200 });
    },
};

export default testWorker;
export { SmokeContainer, smokeContainer };
export type { Env };
