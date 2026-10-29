import { expect, test } from "@playwright/test";

/**
 * Live smoke for the services example (plan 457): an action calls a fetch
 * service and a `WorkerEntrypoint` RPC service, both running as auxiliary
 * Workers of the same `vite dev` session.
 *
 * Only a live session proves the wiring end to end — the Vite plugin adding the
 * auxiliary Workers, reconcile writing the `services[]` bindings, and the shard
 * resolving `ctx.services` off the real `env`. The workerd suite in
 * `@lunora/server` covers `createServices` against real bindings, not this.
 */
test("an action calls a fetch service and an RPC service", async ({ request }) => {
    const response = await request.post("/_lunora/rpc", {
        data: { args: { prompt: "hi" }, functionPath: "documents:summarise" },
    });

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toStrictEqual({ result: { completed: "completed hi", parsed: "/documents/7" } });
});
