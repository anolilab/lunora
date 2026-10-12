/**
 * Test entry-point Worker for the privacy example's workerd suite.
 *
 * The suite runs the example's ports against a real Durable Object's SQLite storage. The
 * Durable Object only supplies that storage; each test builds the app's runtime over it.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
    PRIVACY: DurableObjectNamespace<PrivacyTestDO>;
}

export class PrivacyTestDO extends DurableObject<Env> {}

export default {
    fetch: async (): Promise<Response> => new Response("privacy example workerd test worker", { status: 404 }),
};
