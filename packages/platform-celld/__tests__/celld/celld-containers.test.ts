/**
 * The `containers` rating on a live celld.
 *
 * `containers/worker.ts` declares its container classes the way codegen emits
 * them for a `lunora/containers.ts` export, so this runs `LunoraContainer` and
 * `@cloudflare/containers` as an app does, against a real container engine.
 *
 * celld builds every container image when the node starts, so the check needs
 * a Docker or Podman daemon; it runs when `LUNORA_CELLD_CONTAINERS=1` (set in
 * CI). celld finds the engine through `DOCKER_HOST` or the default Docker /
 * OrbStack / Podman socket — colima's is not among them, so point
 * `DOCKER_HOST` at `unix://$HOME/.colima/default/docker.sock` there.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CelldDev } from "./celld-process";
import { startCelldDev, stopCelldDev } from "./celld-process";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "containers");

describe.skipIf(process.env.LUNORA_CELLD_CONTAINERS !== "1")("lunora containers on celld", () => {
    let node: CelldDev | undefined;

    beforeAll(async () => {
        // An image build (and a base-image pull, on a cold runner) precedes serving.
        node = await startCelldDev(PROJECT, 240_000);
    }, 300_000);

    afterAll(async () => {
        await stopCelldDev(node, PROJECT);
    });

    it("routes a request through the container Durable Object to the container's port", async () => {
        expect.assertions(2);

        const response = await fetch(`${String(node?.url)}/hello`);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("hello from a celld container\n");
    });

    // `defineContainer({ allowedHosts | deniedHosts | interceptHttps })` turns on
    // outbound interception, which celld does not implement — the container
    // refuses to start rather than run without the policy. The rating names it;
    // this fails the day celld ships it, so the rating gets revisited.
    it("refuses to start a container with an egress policy", async () => {
        expect.assertions(2);

        const response = await fetch(`${String(node?.url)}/fenced`);

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toMatch(/interceptAllOutboundHttp\(\) is not implemented in celld/u);
    });
});
