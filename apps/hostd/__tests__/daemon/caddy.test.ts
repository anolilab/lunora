import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askApproves, buildCaddyConfig, CaddyController } from "../../src/daemon/caddy";
import type { CaddyConfig } from "../../src/daemon/config";
import { silentLogger } from "../../src/daemon/log";
import { freePort } from "./helpers/box";

const CADDY: CaddyConfig = { adminAddress: "127.0.0.1:2019", askAddress: "127.0.0.1:2020", httpPort: 80, httpsPort: 443, tls: true };

const ROUTES = [
    { alias: "shop", hostname: "shop.bx.boxes.lunora.app" },
    { alias: "shop", hostname: "www.shop.example" },
    { alias: "docs", hostname: "docs.bx.boxes.lunora.app" },
];

type Json = Record<string, any>;

const build = (overrides: Partial<Parameters<typeof buildCaddyConfig>[0]> = {}): Json =>
    buildCaddyConfig({
        accessLogPath: "/var/lib/lunora-hostd/caddy/access.log",
        caddy: CADDY,
        hostname: "bx.boxes.lunora.app",
        ports: new Map([["shop", 20_000]]),
        routes: ROUTES,
        ...overrides,
    });

describe(buildCaddyConfig, () => {
    it("routes each alias's hostnames to its fleet, readiness-gated and rate-limited", () => {
        expect.assertions(5);

        const server = build()["apps"].http.servers.lunora;
        const shop = server.routes.find((route: Json) => route.match?.[0].host.includes("www.shop.example"));
        const handlers = shop.handle[0].routes[0].handle as Json[];

        expect(shop.match).toStrictEqual([{ host: ["shop.bx.boxes.lunora.app", "www.shop.example"] }]);
        expect(handlers.map((handler) => handler["handler"])).toStrictEqual(["rate_limit", "encode", "reverse_proxy"]);
        expect(handlers[2]).toMatchObject({
            flush_interval: -1,
            health_checks: { active: { uri: "/.well-known/celld/health" } },
            load_balancing: { try_duration: "20s" },
            upstreams: [{ dial: "127.0.0.1:20000" }],
        });
        // Event streams are never compressed: the encoder only matches listed types.
        expect(JSON.stringify(handlers[1])).not.toContain("event-stream");
        expect(server.read_header_timeout).toBe("10s");
    });

    it("answers 503 for a routed alias whose fleet is not running, and 404 for an unrouted host", () => {
        expect.assertions(2);

        const { routes } = build()["apps"].http.servers.lunora;
        const docs = routes.find((route: Json) => route.match?.[0].host.includes("docs.bx.boxes.lunora.app"));

        expect(docs.handle[0].routes[0].handle[0]).toMatchObject({ handler: "static_response", status_code: 503 });
        expect(routes.at(-1)).toMatchObject({ handle: [{ status_code: 404 }], terminal: true });
    });

    it("gates on-demand TLS on hostd's ask endpoint, and writes a JSON access log", () => {
        expect.assertions(2);

        const config = build();

        expect(config["apps"].tls.automation).toStrictEqual({
            on_demand: { permission: { endpoint: "http://127.0.0.1:2020/ask", module: "http" } },
            policies: [{ on_demand: true }],
        });
        expect(config["logging"].logs.lunora_access).toMatchObject({
            encoder: { format: "json" },
            writer: { filename: "/var/lib/lunora-hostd/caddy/access.log" },
        });
    });

    it("serves plain HTTP with no certificates when TLS is off", () => {
        expect.assertions(2);

        const config = build({ caddy: { ...CADDY, httpPort: 8080, tls: false } });

        expect(config["apps"].tls).toBeUndefined();
        expect(config["apps"].http.servers.lunora).toMatchObject({ automatic_https: { disable: true }, listen: [":8080"] });
    });

    it("is deterministic", () => {
        expect.assertions(1);

        expect(JSON.stringify(build({ routes: ROUTES.toReversed() }))).toBe(JSON.stringify(build()));
    });
});

describe(askApproves, () => {
    it("approves a routed hostname and the box's own, nothing else", () => {
        expect.assertions(3);

        expect(askApproves("www.shop.example", ROUTES, "bx.boxes.lunora.app")).toBe(true);
        expect(askApproves("bx.boxes.lunora.app", ROUTES, "bx.boxes.lunora.app")).toBe(true);
        expect(askApproves("attacker.example", ROUTES, "bx.boxes.lunora.app")).toBe(false);
    });
});

describe(CaddyController, () => {
    let dataDir: string;

    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), "lunora-hostd-caddy-"));
    });

    afterEach(() => {
        rmSync(dataDir, { force: true, recursive: true });
    });

    it("loads a config only when it changed, and keeps the previous one when Caddy refuses", async () => {
        expect.assertions(6);

        let refuse = false;
        const fetcher = vi.fn<() => Promise<Response>>(async () =>
            refuse ? new Response("unknown module", { status: 400 }) : new Response(null, { status: 200 }),
        );
        const controller = new CaddyController({
            caddy: CADDY,
            dataDir,
            fetch: fetcher,
            hostname: "bx.boxes.lunora.app",
            logger: silentLogger,
        });

        await expect(controller.apply(ROUTES, new Map())).resolves.toBe(true);
        await expect(controller.apply(ROUTES, new Map())).resolves.toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        // Caddy refuses an admin request from Node's fetch without its own origin.
        expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ origin: "http://127.0.0.1:2019" });

        refuse = true;

        await expect(controller.apply([], new Map())).resolves.toBe(false);
        expect(controller.lastError).toMatch(/caddy refused the config \(400\): unknown module/u);
    });

    it("serves the ask endpoint from the current routing table", async () => {
        expect.assertions(3);

        const askAddress = `127.0.0.1:${String(await freePort())}`;
        const controller = new CaddyController({
            caddy: { ...CADDY, askAddress },
            dataDir,
            fetch: async () => new Response(null),
            hostname: "bx.boxes.lunora.app",
            logger: silentLogger,
        });

        await controller.listenAsk();
        await controller.apply(ROUTES, new Map());

        try {
            const ask = async (domain: string): Promise<number> => {
                const response = await fetch(`http://${askAddress}/ask?domain=${domain}`);

                return response.status;
            };

            await expect(ask("www.shop.example")).resolves.toBe(200);
            await expect(ask("unrouted.example")).resolves.toBe(403);

            await controller.apply([], new Map());

            await expect(ask("www.shop.example")).resolves.toBe(403);
        } finally {
            await controller.close();
        }
    });
});
