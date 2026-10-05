/**
 * The W7 gate (plan 458): `test:hostd` upgrades a live box from release N to
 * N+1 while an alias serves, and the alias answers before and after.
 *
 * Release N is installed the way `install.sh` installs one — by its own
 * `lunora-hostd install-release` — and N+1 arrives as an `upgrade` job: a
 * signed manifest from the control plane, artifacts over HTTPS (celld
 * gzipped, as upstream ships it), checked, installed beside N, `current`
 * switched, and the daemon exits for its supervisor (systemd under
 * `LUNORA_HOSTD_ISOLATION=1`, the lane itself otherwise) to start N+1, which
 * brings the fleet and Caddy back.
 *
 * Both releases' `lunora-hostd` are builds of this source that trust a key
 * the test generates (`helpers/test-release.ts`) — a shipped binary trusts
 * only the keys compiled into it — each run on this machine's node. celld
 * and Caddy are the real binaries the lane runs.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { AwsClient } from "aws4fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { currentPlatform } from "../../src/daemon/release-install";
import type { HelloMessage } from "../../src/wire/types";
import { freePort } from "../daemon/helpers/box";
import { FakeControlPlane } from "../daemon/helpers/fake-control-plane";
import type { TestReleaseKey } from "../helpers/test-release";
import { buildTestHostd, createTestReleaseKey, signTestRelease } from "../helpers/test-release";
import type { LaneBox } from "./lane";
import { createLaneBox, ISOLATED, LANE_CREDENTIALS, patchConfig, required, run, SYSTEM_PATH, tool } from "./lane";

const ALIAS = "lane-live";

const BUCKET = "hostd-lane-upgrade";

const TOKEN = `lbe_${"6d".repeat(32)}`;

const VERSION_N = "0.0.1-lane";

const VERSION_N1 = "0.0.2-lane";

const RELEASE_N = "hostd-v0_0_1-lane";

const RELEASE_N1 = "hostd-v0_0_2-lane";

const WORKER = 'export default { fetch() { return new Response("served across the upgrade"); } };\n';

/** GET `/` from Caddy on `port` for `host`; never rejects. */
const viaCaddy = async (port: number, host: string): Promise<{ body: string; status: number }> =>
    new Promise((resolve) => {
        const outgoing = request({ headers: { host }, host: "127.0.0.1", path: "/", port, timeout: 30_000 }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            response.on("end", () => {
                resolve({ body, status: response.statusCode ?? 0 });
            });
        });

        outgoing.once("error", () => {
            resolve({ body: "", status: 0 });
        });
        outgoing.once("timeout", () => {
            outgoing.destroy();
        });
        outgoing.end();
    });

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const pollUntil = async <T>(read: () => Promise<T> | T, done: (value: T) => boolean, deadlineMs: number): Promise<T> => {
    const deadline = Date.now() + deadlineMs;
    let value = await read();

    while (!done(value) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        await pause(500);
        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        value = await read();
    }

    return value;
};

describe.sequential("lunora-hostd upgrades a live box from release N to N+1", () => {
    const endpoint = required("LUNORA_HOSTD_S3_ENDPOINT");
    const platform = currentPlatform() ?? "linux-x64";
    let plane: FakeControlPlane;
    let box: LaneBox;
    let key: TestReleaseKey;
    /** Where the test's builds, certificate and downloads live: under /opt on the systemd box, so the unit can read them. */
    let work: string;
    let artifacts: Server | undefined;
    let httpPort: number;

    const hellos = (): HelloMessage[] => plane.received.filter((message): message is HelloMessage => message.type === "hello");

    beforeAll(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        key = createTestReleaseKey();
        work = ISOLATED ? "/opt/lunora-hostd-lane" : mkdtempSync(join(tmpdir(), "lunora-hostd-upgrade-"));
        rmSync(work, { force: true, recursive: true });
        mkdirSync(join(work, "n"), { recursive: true });
        mkdirSync(join(work, "n1"), { recursive: true });
        chmodSync(work, 0o755);

        // Two builds of this source, N and N+1, trusting the test's key.
        for (const [directory, version] of [
            ["n", VERSION_N],
            ["n1", VERSION_N1],
        ] as const) {
            // eslint-disable-next-line no-await-in-loop -- two builds, one after the other
            await buildTestHostd({
                bundlePath: join(work, directory, "lunora-hostd.cjs"),
                launcherPath: join(work, directory, "launcher"),
                trustedKeys: key.trustedKeys,
                version,
            });
        }

        // N+1's artifacts, over HTTPS from a certificate the daemon is told to trust.
        execFileSync(tool("openssl"), [
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-keyout",
            join(work, "tls.key"),
            "-out",
            join(work, "tls.pem"),
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
        ]);
        chmodSync(join(work, "tls.pem"), 0o644);

        const celld = readFileSync(required("LUNORA_CELLD_BIN"));
        const caddy = readFileSync(required("LUNORA_CADDY_BIN"));
        const served = new Map<string, Buffer>([
            ["/n1/caddy", caddy],
            ["/n1/celld", gzipSync(celld)],
            ["/n1/lunora-hostd", readFileSync(join(work, "n1", "launcher"))],
        ]);

        const server = createHttpsServer({ cert: readFileSync(join(work, "tls.pem")), key: readFileSync(join(work, "tls.key")) }, (incoming, outgoing) => {
            const bytes = served.get(incoming.url ?? "");

            outgoing.writeHead(bytes === undefined ? 404 : 200).end(bytes);
        });

        artifacts = server;
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });

        const base = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/n1`;

        const envelopeN1 = signTestRelease(key, RELEASE_N1, base, {
            caddy: { bytes: caddy, version: "v2.11.6" },
            celld: { bytes: served.get("/n1/celld") as Buffer, compression: "gzip", version: "v0.6.0" },
            hostd: { bytes: served.get("/n1/lunora-hostd") as Buffer, version: VERSION_N1 },
        });

        plane.manifests.set(RELEASE_N1, JSON.stringify(envelopeN1));

        box = await createLaneBox({
            environment: { NODE_EXTRA_CA_CERTS: join(work, "tls.pem") },
            // Release N, installed as install.sh installs one: by its own install-release.
            layout: async (installDirectory) => {
                const from = join(work, "n", "download");
                const manifestN = join(work, "n", "manifest.json");
                const launcherN = readFileSync(join(work, "n", "launcher"));

                mkdirSync(from, { recursive: true });
                writeFileSync(join(from, "lunora-hostd"), launcherN);
                copyFileSync(required("LUNORA_CELLD_BIN"), join(from, "celld"));
                copyFileSync(required("LUNORA_CADDY_BIN"), join(from, "caddy"));
                writeFileSync(
                    manifestN,
                    JSON.stringify(
                        signTestRelease(key, RELEASE_N, "https://artifacts.invalid/n", {
                            caddy: { bytes: caddy, version: "v2.11.6" },
                            celld: { bytes: celld, version: "v0.6.0" },
                            hostd: { bytes: launcherN, version: VERSION_N },
                        }),
                    ),
                );

                const installed = await run(
                    join(work, "n", "launcher"),
                    ["install-release", manifestN, "--from", from, "--install-dir", installDirectory, "--platform", platform],
                    { PATH: SYSTEM_PATH },
                );

                if (installed.code !== 0) {
                    throw new Error(`install-release of release N failed:\n${installed.output}`);
                }
            },
        });

        const s3 = new AwsClient({
            accessKeyId: LANE_CREDENTIALS.AWS_ACCESS_KEY_ID,
            region: "us-east-1",
            secretAccessKey: LANE_CREDENTIALS.AWS_SECRET_ACCESS_KEY,
            service: "s3",
        });
        const created = await s3.fetch(`${endpoint}/${BUCKET}`, { method: "PUT" });

        if (!created.ok && created.status !== 409) {
            throw new Error(`could not create the bucket at ${endpoint}: ${String(created.status)}`);
        }
    });

    afterAll(async () => {
        await box?.stop().catch(() => undefined);
        await plane?.close();
        await new Promise<void>((resolve) => {
            if (artifacts === undefined) {
                resolve();

                return;
            }

            artifacts.close(() => {
                resolve();
            });
        });
        await box?.remove();
        rmSync(work, { force: true, recursive: true });
    });

    it("runs release N, installed by its own install-release", async () => {
        expect.assertions(3);

        const enrolled = await box.enrol({ bucket: `s3://${BUCKET}`, controlPlane: plane.origin, endpoint, token: TOKEN });

        expect(enrolled.code, enrolled.output).toBe(0);

        httpPort = box.isolated ? 80 : await freePort();

        const [adminPort, askPort] = [await freePort(), await freePort()];

        patchConfig(box.configPath, (config) => {
            return {
                ...config,
                caddy: { adminAddress: `127.0.0.1:${String(adminPort)}`, askAddress: `127.0.0.1:${String(askPort)}`, httpPort, httpsPort: 443, tls: false },
            };
        });
        await box.start();
        await pollUntil(
            () => plane.authentications,
            (count) => count > 0,
            60_000,
        );

        expect(readlinkSync(join(box.installDir, "current"))).toBe(RELEASE_N);
        expect(hellos()[0]?.versions.hostd, box.logs()).toBe(VERSION_N);
    });

    it("serves an alias on release N", async () => {
        expect.assertions(2);

        plane.releases.set("dep_live_1", JSON.stringify({ bundle: Buffer.from(WORKER).toString("base64"), manifest: { bindings: [] } }));
        plane.pushRoutes([{ alias: ALIAS, hostname: `${ALIAS}.${plane.hostname}` }]);

        const { progress, result } = await plane.dispatch({
            alias: ALIAS,
            crons: [],
            deploymentId: "dep_live_1",
            kind: "deploy",
            releaseUrl: `${plane.origin}/v1/boxes/releases/dep_live_1`,
            vars: {},
        });

        expect(result, `${progress.join("\n")}\n${box.logs()}`).toMatchObject({ ok: true });

        const before = await pollUntil(
            async () => viaCaddy(httpPort, `${ALIAS}.${plane.hostname}`),
            (response) => response.status === 200,
            90_000,
        );

        expect(before, box.logs()).toStrictEqual({ body: "served across the upgrade", status: 200 });
    });

    it("upgrades to N+1 from a signed manifest: installs it beside N, switches current, and restarts into it", async () => {
        expect.assertions(4);

        const sessionsBefore = plane.authentications;
        const { progress, result } = await plane.dispatch({
            kind: "upgrade",
            manifestUrl: `${plane.origin}/v1/hostd/releases/${RELEASE_N1}/manifest`,
            releaseId: RELEASE_N1,
        });

        expect(result, `${progress.join("\n")}\n${box.logs()}`).toMatchObject({ ok: true });
        expect(progress).toContain(`lunora-hostd ${VERSION_N1} installed; restarting into it`);

        // The old daemon exits; its supervisor starts the new one, which connects again.
        await pollUntil(
            () => plane.authentications,
            (count) => count > sessionsBefore,
            120_000,
        );

        expect(hellos().at(-1)?.versions.hostd, box.logs()).toBe(VERSION_N1);
        // N stays beside N+1, for a rollback.
        expect([
            readlinkSync(join(box.installDir, "current")),
            readFileSync(join(box.installDir, RELEASE_N, "manifest.json"), "utf8").includes(RELEASE_N),
        ]).toStrictEqual([RELEASE_N1, true]);
    });

    it("serves the alias again on release N+1", async () => {
        expect.assertions(2);

        const after = await pollUntil(
            async () => viaCaddy(httpPort, `${ALIAS}.${plane.hostname}`),
            (response) => response.status === 200,
            120_000,
        );

        expect(after, box.logs()).toStrictEqual({ body: "served across the upgrade", status: 200 });
        expect(hellos().at(-1)?.fleets).toStrictEqual([{ alias: ALIAS, deploymentId: "dep_live_1", state: "running" }]);
    });

    it("stops cleanly", async () => {
        expect.assertions(1);

        await plane.dispatch({ alias: ALIAS, deleteData: true, kind: "destroy" });

        await expect(box.stop()).resolves.toBe(0);
    });
});
