/**
 * The app the services check runs: `ctx.services` is built the way the
 * generated code builds it, through `createServices` over the Worker `env`,
 * and `GET /services` calls both kinds of service through it.
 */
import type { ServiceBindingSpec, ServiceFetcher } from "@lunora/server";
import { createServices } from "@lunora/server";

/** What codegen emits for a `lunora.config` service of each kind. */
const SPECS: ReadonlyArray<ServiceBindingSpec> = [
    { binding: "PARSER", name: "parser" },
    { binding: "MATH", name: "math", rpc: true },
];

type Services = { math: { double: (value: number) => Promise<number> }; parser: ServiceFetcher };

// A Workers entry module: the runtime reads the handlers off the default export.
export default {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
        if (new URL(request.url).pathname !== "/services") {
            return new Response("not found", { status: 404 });
        }

        const services = createServices(env, SPECS) as Services;
        // Detached, the way the docs hand it to a client: `createServices` binds it.
        const { fetch: parserFetch } = services.parser;
        const fetched = await parserFetch("https://parser/documents", { method: "POST" });

        return Response.json({ doubled: await services.math.double(21), fetched: await fetched.text(), status: fetched.status });
    },
};
