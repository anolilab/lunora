/**
 * The test entry-point Worker for the package's workerd suite. The package has no bindings of its own: its
 * ports are in-memory doubles, so the suite needs a Worker only to boot the runtime.
 */
export default {
    fetch: async (): Promise<Response> => new Response("privacy workerd test worker", { status: 404 }),
};
