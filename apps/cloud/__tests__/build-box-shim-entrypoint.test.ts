/* eslint-disable max-classes-per-file -- the shim subclasses a WorkerEntrypoint-shaped class, so each case is a class of its own */
import { describe, expect, it } from "vitest";

import { wrapEntry } from "../containers/build/shim-runtime.mjs";

/**
 * The plain-Worker entry shim for a Worker whose default export is a
 * `WorkerEntrypoint` class rather than a handler object: the shim answers with
 * a subclass that overrides `fetch()`, reaches the Worker's `scheduled()` and
 * `queue()` through `this`, and hands everything else to `super.fetch()`.
 * The object shape is `build-box-shim.test.ts`.
 */

const TOKEN = "admin-token-for-tests";
const ENV = { LUNORA_ADMIN_TOKEN: TOKEN };
const CONTEXT = { waitUntil: () => {} };

const post = (path: string, body: unknown, token = TOKEN): Request =>
    new Request(`https://tenant.internal${path}`, { body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` }, method: "POST" });

/** What `cloudflare:workers`' `WorkerEntrypoint` gives a subclass: `this.env` and `this.ctx`. */
class Entrypoint {
    public ctx: unknown;

    public env: unknown;

    public constructor(context: unknown, env: unknown) {
        this.ctx = context;
        this.env = env;
    }
}

describe("plain-Worker entry shim, WorkerEntrypoint default export", () => {
    it("subclasses it: fan-out from this.scheduled() and this.queue(), everything else to super.fetch()", async () => {
        expect.assertions(5);

        class Tenant extends Entrypoint {
            public seen: unknown[] = [];

            public async fetch(request: Request): Promise<Response> {
                return new Response(`tenant ${new URL(request.url).pathname} ${String(this.seen.length)}`);
            }

            public async queue(batch: { messages: { retry: () => void }[]; queue: string }): Promise<void> {
                this.seen.push(batch.queue);
                batch.messages[0]?.retry();
            }

            public async scheduled(controller: { cron: string }): Promise<void> {
                this.seen.push(controller.cron, this.env);
            }
        }

        const Wrapped = wrapEntry(Tenant, { "--jobs": "jobs" }) as new (context: unknown, env: unknown) => Tenant;
        const instance = new Wrapped(CONTEXT, ENV);
        const scheduled = await instance.fetch(post("/_lunora/scheduled", { cron: "0 0 * * *" }));
        const queued = await instance.fetch(
            post("/_lunora/queue", {
                messages: [
                    { body: 1, id: "a" },
                    { body: 2, id: "b" },
                ],
                queue: "acme--jobs",
            }),
        );
        const passed = await instance.fetch(new Request("https://app.example/hello"));

        expect(instance).toBeInstanceOf(Tenant);
        await expect(scheduled.json()).resolves.toStrictEqual({ cron: "0 0 * * *", ok: true });
        await expect(queued.json()).resolves.toStrictEqual({ retry: ["a"] });
        await expect(passed.text()).resolves.toBe("tenant /hello 3");
        expect(instance.seen).toStrictEqual(["0 0 * * *", ENV, "jobs"]);
    });

    it("refuses the routes without the bearer, and answers 501 when the class has no fetch()", async () => {
        expect.assertions(2);

        const Wrapped = wrapEntry(Entrypoint, {}) as new (context: unknown, env: unknown) => { fetch: (request: Request) => Promise<Response> };
        const instance = new Wrapped(CONTEXT, ENV);
        const refused = await instance.fetch(post("/_lunora/scheduled", { cron: "* * * * *" }, "wrong"));
        const ordinary = await instance.fetch(new Request("https://app.example/"));

        expect(refused.status).toBe(403);
        expect(ordinary.status).toBe(501);
    });
});
