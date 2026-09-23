/**
 * Entry-point Worker for the `workerd` vitest project.
 *
 * `@cloudflare/vitest-plugin` needs a `main` to boot the isolate; the suites in
 * this directory drive the store core directly from the test file against
 * `env.DB`, so nothing routes through this handler. It exists to declare
 * {@link Env}, which `env.d.ts` folds into `Cloudflare.Env`.
 */
interface Env {
    DB: D1Database;
}

const testWorker = {
    fetch(): Response {
        return new Response("sql-store-test-worker", { status: 200 });
    },
};

export default testWorker;
export type { Env };
