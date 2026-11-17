/**
 * The `services` rating on a live celld.
 *
 * celld resolves a service binding from the target Worker's deployment record
 * in the local state, so this boots the parser service once into the
 * `services/` state — as `lunora dev` registers each `lunora.config` service —
 * stops it, and starts the app on the same state without cleaning it. The app
 * then calls a fetch service and a `WorkerEntrypoint` RPC service through
 * `createServices`, the module `ctx.services` is built from.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CelldDev } from "./celld-process";
import { startCelldDev, stopCelld, stopCelldDev } from "./celld-process";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "services");

describe("lunora services on celld", () => {
    let app: CelldDev | undefined;

    beforeAll(async () => {
        // Booting the service records its deployment; it is stopped before the app starts.
        const service = await startCelldDev(join(PROJECT, "parser.wrangler.jsonc"));

        await stopCelld(service.child);

        app = await startCelldDev(PROJECT, 90_000, { clean: false });
    }, 240_000);

    afterAll(async () => {
        await stopCelldDev(app, PROJECT);
    });

    it("calls a fetch service and an RPC service through ctx.services", async () => {
        expect.assertions(2);

        const response = await fetch(`${String(app?.url)}/services`);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ doubled: 42, fetched: "parsed POST /documents", status: 200 });
    });
});
