/**
 * The daemon end to end against a fake control plane and fake celld/Caddy:
 * the handshake, then each job kind as the control plane would send it.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { permissionsOf } from "../../src/daemon/config";
import { silentLogger } from "../../src/daemon/log";
import { Daemon } from "../../src/daemon/run";
import { loadState } from "../../src/daemon/state";
import type { DeployJob } from "../../src/wire/types";
import type { TestBox } from "./helpers/box";
import { createTestBox, unisolatedSystem } from "./helpers/box";
import { caddyInvocations, caddyLoads, celldInvocations, setFakeFlag } from "./helpers/fake-binaries";
import { FakeControlPlane } from "./helpers/fake-control-plane";

const storedRelease = (): string =>
    JSON.stringify({
        assets: {
            config: { not_found_handling: "single-page-application" },
            files: [
                { content: Buffer.from("<h1>hi</h1>").toString("base64"), path: "/index.html" },
                { content: Buffer.from("body{}").toString("base64"), path: "/assets/app.css" },
            ],
        },
        bundle: Buffer.from("export default { fetch() { return new Response('ok'); } };").toString("base64"),
        manifest: {
            bindings: [
                { binding: "ASSETS", type: "assets" },
                { binding: "DB", resource: "app", type: "d1" },
                { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" },
            ],
            compatibilityDate: "2026-04-01",
        },
    });

const deployJob = (plane: FakeControlPlane, overrides: Partial<DeployJob> = {}): DeployJob => {
    return {
        alias: "my-app",
        crons: ["*/5 * * * *"],
        deploymentId: "dep_1",
        kind: "deploy",
        releaseUrl: `${plane.origin}/v1/boxes/releases/dep_1`,
        vars: { API_KEY: "secret-value" },
        ...overrides,
    };
};

describe("the daemon", () => {
    let plane: FakeControlPlane;
    let box: TestBox;
    let daemon: Daemon;
    let running: Promise<number>;

    beforeEach(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        box = await createTestBox(plane);
        plane.releases.set("dep_1", storedRelease());
        daemon = new Daemon({ config: box.config, isolation: unisolatedSystem(), logger: silentLogger, reportTickMs: 100 });
        running = daemon.run();
        await plane.authenticated();
    });

    afterEach(async () => {
        daemon.stop();
        await running;
        await plane.close();
        box.cleanup();
    });

    it("says hello with its fleets and versions, then authenticates", () => {
        expect.assertions(2);

        const hello = plane.received.find((message) => message.type === "hello");

        expect(hello).toMatchObject({ boxId: plane.boxId, fleets: [], protocol: 1, versions: { caddy: "v2.11.6", celld: "0.6.0" } });
        expect(plane.received.some((message) => message.type === "auth")).toBe(true);
    });

    it("reports its isolation self-check in hello: single-trust, naming each failed check", () => {
        expect.assertions(1);

        expect(plane.received.find((message) => message.type === "hello")).toMatchObject({
            isolation: {
                problems: [
                    "fleet user: no local user lunora-fleet (install.sh creates it)",
                    "egress policy: not applied: fleets do not run as their own user",
                    expect.stringMatching(/^memory limits: not running as a systemd service/u),
                ],
                status: "single-trust",
            },
        });
    });

    it("starts no fleet when the self-check fails on a box not enrolled --single-trust", async () => {
        expect.assertions(4);

        daemon.stop();
        await running;
        daemon = new Daemon({ config: { ...box.config, singleTrust: false }, isolation: unisolatedSystem(), logger: silentLogger });
        running = daemon.run();
        await plane.authenticated(2);

        expect(plane.received.findLast((message) => message.type === "hello")).toMatchObject({ isolation: { status: "refused" } });

        const { result } = await plane.dispatch(deployJob(plane));
        const diagnosis = await plane.dispatch({ kind: "diagnose" });

        expect(result.error).toMatchObject({ code: "ISOLATION_FAILED", message: expect.stringMatching(/no local user lunora-fleet/u) });
        expect(celldInvocations(box.records).some((run) => run.argv[0] === "--bucket" || run.argv[0] === "deploy")).toBe(false);
        expect(diagnosis.progress).toContain("isolation: refused (no fleet starts)");
    });

    it("answers a ping with a pong", async () => {
        expect.assertions(1);

        const pong = plane.nextFrame((message) => message.type === "pong");

        plane.send({ type: "ping" });

        await expect(pong).resolves.toStrictEqual({ type: "pong" });
    });

    it("deploys a release end to end", async () => {
        expect.assertions(15);

        plane.pushRoutes([{ alias: "my-app", hostname: `my-app.${plane.hostname}` }]);

        const { progress, result } = await plane.dispatch(deployJob(plane));

        expect(result).toStrictEqual({ jobId: "job_1", ok: true, type: "result", url: `http://my-app.${plane.hostname}:8080` });
        expect(progress[0]).toBe("fetching release dep_1");
        expect(progress).toContain("fleet my-app is healthy");
        expect(progress.some((line) => line.startsWith("celld: "))).toBe(true);

        // The release fetch was signed, timestamped and verified.
        expect(plane.signedRequests).toMatchObject([{ path: "/v1/boxes/releases/dep_1", verified: true }]);

        // The release directory: bundle, assets and the celld config (0600, it holds the secrets).
        const directory = join(box.config.dataDir, "releases", "dep_1");
        const config = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8")) as Record<string, unknown>;

        expect(readFileSync(join(directory, "worker.js"), "utf8")).toContain("new Response('ok')");
        expect(readFileSync(join(directory, "assets", "assets", "app.css"), "utf8")).toBe("body{}");
        expect(config).toMatchObject({
            d1_databases: [{ binding: "DB", database_name: "my-app--db" }],
            name: "my-app",
            triggers: { crons: ["*/5 * * * *"] },
            vars: { API_KEY: "secret-value" },
        });
        expect(permissionsOf(statSync(join(directory, "wrangler.json")).mode)).toBe(0o600);

        // celld deploy, then a node on loopback ports with the fleet's bucket prefix.
        const runs = celldInvocations(box.records);
        const deploy = runs.find((run) => run.argv[0] === "deploy");
        const node = runs.find((run) => run.argv[0] === "--bucket");
        const { first } = box.config.ports;

        expect(deploy?.argv).toStrictEqual([
            "deploy",
            directory,
            "--bucket",
            "s3://customer-bucket/fleets/my-app",
            "--endpoint",
            `${plane.origin}/s3`,
            "--region",
            "us-east-1",
            "--json",
        ]);
        expect(node?.argv).toStrictEqual([
            "--bucket",
            "s3://customer-bucket/fleets/my-app",
            "--endpoint",
            `${plane.origin}/s3`,
            "--region",
            "us-east-1",
            "--listen",
            `127.0.0.1:${String(first)}`,
            "--internal-listen",
            `127.0.0.1:${String(first + 1)}`,
            "--advertise",
            `127.0.0.1:${String(first + 1)}`,
            "--trust-forwarded-headers",
        ]);

        // The fleet's environment is the allowlist, built from nothing: no daemon variable leaks in.
        const fleetDirectory = join(box.config.dataDir, "fleets", "my-app");

        expect(node?.env).toStrictEqual({
            AWS_ACCESS_KEY_ID: "test-key",
            AWS_REGION: "us-east-1",
            AWS_SECRET_ACCESS_KEY: "test-secret",
            CELLD_DURABILITY: "bucket",
            HOME: fleetDirectory,
            LANG: "C.UTF-8",
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            RUST_LOG: "error,celld=warn",
            TMPDIR: fleetDirectory,
        });
        // `celld deploy` gets the same environment, without the node's durability mode.
        expect(deploy?.env).toStrictEqual(Object.fromEntries(Object.entries(node?.env ?? {}).filter(([name]) => name !== "CELLD_DURABILITY")));

        // Caddy now proxies the alias's hostname to the fleet.
        const load = caddyLoads(box.records).at(-1);

        expect(JSON.stringify(load)).toContain(`"dial":"127.0.0.1:${String(first)}"`);
        expect(loadState(box.config.dataDir).fleets["my-app"]).toMatchObject({ deploymentId: "dep_1", publicPort: first, state: "running" });
    });

    it("starts Caddy on its own config, under the data directory", async () => {
        expect.assertions(3);

        await expect.poll(() => caddyInvocations(box.records).filter((run) => run.argv[0] === "run")).toHaveLength(1);

        const caddy = caddyInvocations(box.records).find((run) => run.argv[0] === "run");

        expect(caddy?.argv).toStrictEqual(["run", "--config", join(box.config.dataDir, "caddy", "caddy.json")]);
        expect(caddy?.env["XDG_DATA_HOME"]).toBe(join(box.config.dataDir, "caddy", "data"));
    });

    it("refuses a release URL on another origin without signing anything", async () => {
        expect.assertions(2);

        const { result } = await plane.dispatch(deployJob(plane, { releaseUrl: "https://evil.example/v1/boxes/releases/dep_1" }));

        expect(result.error?.code).toBe("ORIGIN_REFUSED");
        expect(plane.signedRequests).toStrictEqual([]);
    });

    it("fails a deploy celld refuses, and reports why", async () => {
        expect.assertions(2);

        setFakeFlag(box.records, "fail-deploy");

        const { result } = await plane.dispatch(deployJob(plane));

        expect(result.error?.code).toBe("CELLD_FAILED");
        expect(result.error?.message).toMatch(/bucket refused the upload/u);
    });

    it("refuses a release with a binding celld cannot run", async () => {
        expect.assertions(1);

        plane.releases.set("dep_2", JSON.stringify({ bundle: "AA==", manifest: { bindings: [{ binding: "AI", type: "ai" }] } }));

        const { result } = await plane.dispatch(deployJob(plane, { deploymentId: "dep_2", releaseUrl: `${plane.origin}/v1/boxes/releases/dep_2` }));

        expect(result.error).toMatchObject({ code: "RELEASE_INVALID", message: expect.stringMatching(/AI \(ai\)/u) });
    });

    it("refuses an asset path that escapes the release directory", async () => {
        expect.assertions(1);

        plane.releases.set(
            "dep_3",
            JSON.stringify({
                assets: { files: [{ content: "AA==", path: "/../../etc/passwd" }] },
                bundle: "AA==",
                manifest: { bindings: [{ binding: "ASSETS", type: "assets" }] },
            }),
        );

        const { result } = await plane.dispatch(deployJob(plane, { deploymentId: "dep_3", releaseUrl: `${plane.origin}/v1/boxes/releases/dep_3` }));

        expect(result.error?.code).toBe("RELEASE_INVALID");
    });

    it("destroys a fleet and keeps its data unless told to delete it", async () => {
        expect.assertions(4);

        await plane.dispatch(deployJob(plane));
        plane.putObjects("customer-bucket", ["fleets/my-app/deploy/current.json", "fleets/other/keep.json"]);

        const { progress, result } = await plane.dispatch({ alias: "my-app", deleteData: false, kind: "destroy" });

        expect(result.ok).toBe(true);
        expect(progress).toContain("kept s3://customer-bucket/fleets/my-app/");
        expect([...(plane.objects.get("customer-bucket") ?? [])]).toHaveLength(2);
        expect(loadState(box.config.dataDir).fleets["my-app"]).toBeUndefined();
    });

    it("deletes exactly the fleet's prefix with deleteData", async () => {
        expect.assertions(3);

        await plane.dispatch(deployJob(plane));
        plane.putObjects("customer-bucket", [
            "fleets/my-app/deploy/current.json",
            "fleets/my-app/cells/a.db",
            "fleets/my-app-2/keep.json",
            "fleets/other/keep.json",
        ]);

        const { progress, result } = await plane.dispatch({ alias: "my-app", deleteData: true, kind: "destroy" });

        expect(result.ok).toBe(true);
        expect(progress).toContain("deleted 2 objects");
        expect([...(plane.objects.get("customer-bucket") ?? [])].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "fleets/my-app-2/keep.json",
            "fleets/other/keep.json",
        ]);
    });

    it("diagnoses the box and each fleet with celld diagnose", async () => {
        expect.assertions(4);

        await plane.dispatch(deployJob(plane));

        const { progress, result } = await plane.dispatch({ kind: "diagnose" });

        expect(result.ok).toBe(true);
        expect(progress[0]).toMatch(/^lunora-hostd .+, box box_test_1/u);
        expect(progress[1]).toBe("isolation: single-trust");
        expect(progress.some((line) => line.startsWith('my-app| {"check":"bucket'))).toBe(true);
    });

    it("reloads a fleet by restarting its node", async () => {
        expect.assertions(2);

        await plane.dispatch(deployJob(plane));

        const before = celldInvocations(box.records).filter((run) => run.argv[0] === "--bucket").length;
        const { result } = await plane.dispatch({ alias: "my-app", kind: "reload" });

        expect(result.ok).toBe(true);
        expect(celldInvocations(box.records).filter((run) => run.argv[0] === "--bucket")).toHaveLength(before + 1);
    });

    it("refuses a second job for an alias while one runs", async () => {
        expect.assertions(1);

        const first = plane.dispatch(deployJob(plane));
        const second = await plane.dispatch({ alias: "my-app", kind: "reload" });

        await first;

        expect(second.result.error?.code).toBe("ALIAS_BUSY");
    });

    it("stops (never deletes) a fleet the control plane stops routing, and starts it again when routed", async () => {
        expect.assertions(3);

        plane.pushRoutes([{ alias: "my-app", hostname: `my-app.${plane.hostname}` }]);
        await plane.dispatch(deployJob(plane));

        plane.pushRoutes([]);

        await expect.poll(() => loadState(box.config.dataDir).fleets["my-app"]?.state).toBe("stopped");

        expect(existsSync(join(box.config.dataDir, "releases", "dep_1"))).toBe(true);

        plane.pushRoutes([{ alias: "my-app", hostname: `my-app.${plane.hostname}` }]);

        await expect.poll(() => loadState(box.config.dataDir).fleets["my-app"]?.state).toBe("running");
    });

    it("keeps the previous Caddy config when Caddy rejects a new one", async () => {
        expect.assertions(2);

        plane.pushRoutes([{ alias: "my-app", hostname: `my-app.${plane.hostname}` }]);
        await plane.dispatch(deployJob(plane));

        const loads = caddyLoads(box.records).length;

        setFakeFlag(box.records, "reject-load");
        plane.pushRoutes([{ alias: "my-app", hostname: "shop.example.com" }]);

        await expect.poll(() => daemon.caddy.lastError).toMatch(/unknown module/u);

        expect(caddyLoads(box.records)).toHaveLength(loads);
    });

    it("reports closed minute windows of Caddy's access log, per routed alias", async () => {
        expect.assertions(2);

        plane.pushRoutes([{ alias: "my-app", hostname: `my-app.${plane.hostname}` }]);

        await expect.poll(() => daemon.routeTable).toHaveLength(1);

        // Two minutes ago, so the window is closed by the time the daemon reads it.
        const minute = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
        const line = (status: number, seconds: number): string =>
            `${JSON.stringify({ duration: seconds, logger: "http.log.access.lunora", request: { host: `my-app.${plane.hostname}` }, status, ts: (minute + 1000) / 1000 })}\n`;

        appendFileSync(daemon.caddy.accessLogPath, `${line(200, 0.01)}${line(502, 0.03)}${line(200, 0.02)}`);

        await expect(plane.nextFrame((message) => message.type === "report")).resolves.toStrictEqual({
            perAlias: [{ alias: "my-app", errors: 1, p50Ms: 20, requests: 3 }],
            type: "report",
            windowEnd: minute + 60_000,
            windowStart: minute,
        });
    });

    it("reports a fleet it restored after a restart in hello", async () => {
        expect.assertions(1);

        await plane.dispatch(deployJob(plane));
        daemon.stop();
        await running;

        daemon = new Daemon({ config: box.config, isolation: unisolatedSystem(), logger: silentLogger });
        running = daemon.run();
        await plane.authenticated(2);

        const hellos = plane.received.filter((message) => message.type === "hello");

        expect(hellos.at(-1)).toMatchObject({ fleets: [{ alias: "my-app", deploymentId: "dep_1", state: "running" }] });
    });
});
