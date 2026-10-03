/**
 * The `workerd` project's entry worker: it only has to export the real
 * `BoxSessionDO` so the runtime can host it. The tests drive the object
 * through its namespace binding, exactly as the control plane does.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import type { BoxSessionDO } from "../../src/boxes/session-do";

export { BoxSessionDO } from "../../src/boxes/session-do";

export interface Env {
    BOX_SESSION: DurableObjectNamespace<BoxSessionDO>;
    DB: D1DatabaseLike;
    LUNORA_BOX_DOMAIN: string;
    LUNORA_ORIGIN_URL: string;
    LUNORA_OTLP_ENDPOINT: string;
    SECRET_ENCRYPTION_KEY: string;
}

export default {
    fetch: (): Response => new Response("box session test worker", { status: 404 }),
};
