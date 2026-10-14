import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createRsbuild } from "@rsbuild/core";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraRsbuild } from "../src/rsbuild";
import { createFixture } from "./fixture";

/**
 * Proves the injected proxy actually ROUTES, against a real Rsbuild dev server.
 *
 * The unit tests assert the proxy OBJECT is shaped right; they cannot catch a
 * shape Rsbuild does not honour, or a key it renamed. This drives the real
 * server and reads what comes back.
 *
 * The upstream is a stub HTTP server on the worker port rather than `wrangler
 * dev`, with `worker: false` so the plugin starts nothing. That keeps the test
 * hermetic — no workerd, no Cloudflare account, no multi-second boot — while
 * exercising the part that silently breaks: whether `/_lunora/*` leaves the dev
 * server and arrives upstream, path intact.
 */

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

describe("the injected /_lunora proxy", () => {
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) {
            // eslint-disable-next-line no-await-in-loop -- teardown is sequential by nature
            await cleanup();
        }

        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("routes a request through the dev server to the worker origin", async () => {
        expect.assertions(2);

        // The stub stands in for `wrangler dev`, on an OS-assigned port so
        // concurrent runs cannot collide.
        const received: string[] = [];
        const upstream = createServer((request, response) => {
            received.push(request.url ?? "");
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ from: "worker" }));
        });

        await new Promise<void>((resolve) => {
            upstream.listen(0, "127.0.0.1", resolve);
        });

        cleanups.push(
            async () =>
                new Promise((resolve) => {
                    upstream.close(() => {
                        resolve();
                    });
                }),
        );

        const workerPort = (upstream.address() as AddressInfo).port;
        const root = createFixture();

        roots.push(root);

        const rsbuild = await createRsbuild({
            cwd: root,
            rsbuildConfig: {
                plugins: [lunoraRsbuild({ projectRoot: root, validateWrangler: false, worker: false, workerPort })],
                server: { host: "127.0.0.1", port: 0 },
                source: { entry: { index: "./index.js" } },
            },
        });

        const server = await rsbuild.startDevServer();

        cleanups.push(async () => {
            await server.server.close();
        });

        const response = await fetch(`http://127.0.0.1:${String(server.port)}/_lunora/probe`);

        await expect(response.json()).resolves.toStrictEqual({ from: "worker" });

        // Path preserved, not rewritten — the worker routes on it.
        expect(received).toStrictEqual(["/_lunora/probe"]);
    }, 120_000);

    it("answers /__lunora with the studio, ahead of Rsbuild's history fallback", async () => {
        expect.assertions(2);

        const root = createFixture();

        roots.push(root);

        const rsbuild = await createRsbuild({
            cwd: root,
            rsbuildConfig: {
                plugins: [lunoraRsbuild({ projectRoot: root, validateWrangler: false, worker: false })],
                server: { host: "127.0.0.1", port: 0 },
                source: { entry: { index: "./index.js" } },
            },
        });

        const server = await rsbuild.startDevServer();

        cleanups.push(async () => {
            await server.server.close();
        });

        const response = await fetch(`http://127.0.0.1:${String(server.port)}/__lunora/data`);

        // Registered after the built-ins, a deep link would get the APP's
        // `index.html` from the history fallback — a 200 that looks right and
        // boots the wrong single-page app.
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain("/__lunora/studio.js");
    }, 120_000);

    it("moves the studio with server.base, reading it after every plugin's config hooks", async () => {
        expect.assertions(2);

        const root = createFixture();

        roots.push(root);

        const rsbuild = await createRsbuild({
            cwd: root,
            rsbuildConfig: {
                plugins: [lunoraRsbuild({ projectRoot: root, validateWrangler: false, worker: false })],
                server: { base: "/app", host: "127.0.0.1", port: 0 },
                source: { entry: { index: "./index.js" } },
            },
        });

        const server = await rsbuild.startDevServer();

        cleanups.push(async () => {
            await server.server.close();
        });

        const response = await fetch(`http://127.0.0.1:${String(server.port)}/app/__lunora`);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain("/__lunora/studio.js");
    }, 120_000);

    it("refuses the studio when the project explicitly binds beyond loopback", async () => {
        expect.assertions(1);

        const root = createFixture();

        roots.push(root);

        const rsbuild = await createRsbuild({
            cwd: root,
            rsbuildConfig: {
                plugins: [lunoraRsbuild({ projectRoot: root, validateWrangler: false, worker: false })],
                // An explicit `0.0.0.0` is `--host`: the same refusal `@lunora/vite`
                // gives, even to this loopback request. Leaving `host` unset — the
                // same bind, as Rsbuild's default — does not refuse.

                server: { host: "0.0.0.0", port: 0 },
                source: { entry: { index: "./index.js" } },
            },
        });

        const server = await rsbuild.startDevServer();

        cleanups.push(async () => {
            await server.server.close();
        });

        const response = await fetch(`http://127.0.0.1:${String(server.port)}/__lunora`);

        expect(response.status).toBe(403);
    }, 120_000);
});
