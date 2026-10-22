/**
 * Entry-point Worker for the `workerd` vitest project.
 *
 * `@cloudflare/vitest-plugin` needs a `main` to boot the isolate. The suites in
 * this directory never route through `fetch`: they reach a {@link SqliteDO}'s
 * `state.storage.sql` through `runInDurableObject` (see `./_helpers/do-sqlite.ts`)
 * and run the observability tables over it directly. The class exists only to own a real
 * SQLite-backed Durable Object storage — the SQLite this package ships to.
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
    SQLITE: DurableObjectNamespace<SqliteDO>;
}

class SqliteDO extends DurableObject<Env> {}

const testWorker = {
    fetch(): Response {
        return new Response("observability-test-worker", { status: 200 });
    },
};

export default testWorker;
export type { Env };
export { SqliteDO };
