/**
 * A Lunora container on celld: the class is written the way codegen emits it
 * for a `lunora/containers.ts` export (`_generated/containers.ts`), so this
 * runs `LunoraContainer` and `@cloudflare/containers` as an app would.
 * `GET /hello` goes worker → container Durable Object → the container's HTTP
 * port, and answers with what the container served.
 */
import { defineContainer } from "@lunora/container";
import { LunoraContainer } from "@lunora/container/do";

const box = defineContainer({ defaultPort: 8080, image: "./Dockerfile" });

/** The same image behind an egress allowlist — celld documents outbound interception as unavailable. */
const fenced = defineContainer({ allowedHosts: ["example.com"], defaultPort: 8080, image: "./Dockerfile" });

type Env = { BOX: DurableObjectNamespace; FENCED: DurableObjectNamespace };

class TckBox extends LunoraContainer {
    public constructor(context: ConstructorParameters<typeof LunoraContainer>[0], env: Record<string, unknown>) {
        super(context, env, box, "box");
    }
}

class TckFenced extends LunoraContainer {
    public constructor(context: ConstructorParameters<typeof LunoraContainer>[0], env: Record<string, unknown>) {
        super(context, env, fenced, "fenced");
    }
}

export { TckBox, TckFenced };
// Re-exported the way `_generated/containers.ts` does: the egress path needs it.
export { ContainerProxy } from "@lunora/container/do";

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        const namespace = { "/fenced": env.FENCED, "/hello": env.BOX }[url.pathname];

        if (namespace === undefined) {
            return new Response("not found", { status: 404 });
        }

        // The container serves `/hello` whichever route asked for it.
        return namespace.get(namespace.idFromName("tck")).fetch(new Request(new URL("/hello", request.url)));
    },
};
