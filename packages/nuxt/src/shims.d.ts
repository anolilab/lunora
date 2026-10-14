/**
 * Ambient declaration for the `#lunora/app` virtual the module aliases to the
 * project's Lunora app entry (`appEntry`, default `~/lunora/server`). The Nitro
 * server handler (`runtime/server/lunora.ts`) imports its default export — the
 * built Lunora worker, whose only contract is a `fetch` entrypoint. Declared so
 * the runtime files type-check standalone (Nitro resolves the real module at
 * build time).
 */
declare module "#lunora/app" {
    const app: {
        fetch: (request: Request, env: unknown, context: unknown) => Promise<Response> | Response;
    };

    export default app;
}
