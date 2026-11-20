/**
 * The `workerd` project's entry worker: it only has to export the real
 * `BoxSessionDO` — and the emergency stop's generated stub classes — so the
 * runtime can host them. The tests drive each object through its namespace
 * binding, exactly as the control plane and Cloudflare do.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import type { BoxSessionDO } from "../../src/boxes/session-do";

export { BoxSessionDO } from "../../src/boxes/session-do";
// Written by `vitest.config.ts` from `halt-stub-fixture.ts` (`buildHaltStub`), byte for byte what a halt uploads.
export { ParkedKv, ParkedSqlite } from "./halt-stub.generated";

export interface Env {
    BOX_SESSION: DurableObjectNamespace<BoxSessionDO>;
    DB: D1DatabaseLike;
    LUNORA_BOX_DOMAIN: string;
    LUNORA_ORIGIN_URL: string;
    LUNORA_OTLP_ENDPOINT: string;
    PARKED_KV: DurableObjectNamespace;
    PARKED_SQLITE: DurableObjectNamespace;
    SECRET_ENCRYPTION_KEY: string;
}

export default {
    fetch: (): Response => new Response("box session test worker", { status: 404 }),
};
