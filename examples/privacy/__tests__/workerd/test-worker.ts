/**
 * Test entry-point Worker for the privacy example's workerd suite.
 *
 * The suite runs the example's ports against a real Durable Object's SQLite storage. The
 * Durable Object only supplies that storage; each test builds the app's runtime over it.
 */
import { DurableObject } from "cloudflare:workers";

import type { PrivacyTombstonesDO } from "../../src/server/privacy-tombstones-do";

// The app's tombstone store, unchanged: the suite checks it survives a restore of the shard.
export { PrivacyTombstonesDO } from "../../src/server/privacy-tombstones-do";

export interface Env {
    AUTH_SECRET: string;
    DB: D1Database;
    PRIVACY: DurableObjectNamespace<PrivacyTestDO>;
    PRIVACY_TOMBSTONES: DurableObjectNamespace<PrivacyTombstonesDO>;
}

export class PrivacyTestDO extends DurableObject<Env> {}

export default {
    fetch: async (): Promise<Response> => new Response("privacy example workerd test worker", { status: 404 }),
};
