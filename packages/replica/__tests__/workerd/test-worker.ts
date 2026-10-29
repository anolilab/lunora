/**
 * Entry-point Worker for the `@cloudflare/vitest-plugin` runtime. It exists so
 * workerd can resolve the EventLogDO class, its SQLite migration, and the
 * relay secret binding that the tests run against.
 */
export { EventLogDO } from "../../src/event-log-do";

export interface Env {
    EVENT_LOG_DO: DurableObjectNamespace;
    LUNORA_RELAY_SECRET: string;
}

export default {
    fetch(): Response {
        return new Response("not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;
