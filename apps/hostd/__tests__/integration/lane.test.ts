/**
 * The `test:hostd` lane (plan 458 W4 gate; W8 probe suite): the built
 * `lunora-hostd` against real celld, real Caddy, an S3-compatible bucket and
 * an in-process fake control plane — enrol, session, deploy a release, HTTP
 * through Caddy, a usage report, destroy with `deleteData`.
 *
 * Under `LUNORA_HOSTD_ISOLATION=1` (root, systemd; the CI job runs it under
 * sudo) the box is set up with install.sh's own functions and hostd runs under
 * the real unit, so the lane also proves the isolation: the fleet's node runs
 * as `lunora-fleet` with no capabilities in its own memory cgroup, Caddy
 * binds port 80 with only `net_bind_service`, and neither the deployed app nor
 * a process of the fleet user reaches the celld operator API, Caddy's admin
 * API, hostd's `ask` endpoint or the metadata address — while the bucket stays
 * reachable. See `lane.ts` for what it needs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";

import { AwsClient } from "aws4fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ReportMessage } from "../../src/wire/types";
import { freePort } from "../daemon/helpers/box";
import { FakeControlPlane } from "../daemon/helpers/fake-control-plane";
import type { LaneBox } from "./lane";
import { createLaneBox, ISOLATED, LANE_CREDENTIALS, patchConfig, required, run, SYSTEM_PATH, tool } from "./lane";

const ALIAS = "lane-app";

const BUCKET = "hostd-lane";

const TOKEN = `lbe_${"5e".repeat(32)}`;

/** The Worker the lane deploys: a greeting, and a probe that reports whether a URL is reachable from inside the app. */
const WORKER = `export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/probe") {
            try {
                const response = await fetch(url.searchParams.get("target"), { signal: AbortSignal.timeout(5000) });

                return Response.json({ reached: true, status: response.status });
            } catch (error) {
                return Response.json({ reached: false, error: String(error) });
            }
        }

        return new Response("hello from the hostd lane");
    },
};
`;

const s3 = new AwsClient({
    accessKeyId: LANE_CREDENTIALS.AWS_ACCESS_KEY_ID,
    region: "us-east-1",
    secretAccessKey: LANE_CREDENTIALS.AWS_SECRET_ACCESS_KEY,
    service: "s3",
});

/** Keys under `prefix` in the lane's bucket. */
const listKeys = async (endpoint: string, prefix: string): Promise<string[]> => {
    const response = await s3.fetch(`${endpoint}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}`);
    const body = await response.text();

    return [...body.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((match) => match[1] ?? "");
};

/** GET `path` from Caddy on `port`, as a client asking for `host`. */
const viaCaddy = async (port: number, host: string, path: string): Promise<{ body: string; status: number }> =>
    new Promise((resolve, reject) => {
        // Longer than Caddy's own 20 s wait for a healthy upstream, so its answer arrives rather than our timeout.
        const outgoing = request({ headers: { host }, host: "127.0.0.1", path, port, timeout: 30_000 }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            response.on("end", () => {
                resolve({ body, status: response.statusCode ?? 0 });
            });
        });

        outgoing.once("error", reject);
        outgoing.once("timeout", () => {
            outgoing.destroy(new Error("timed out"));
        });
        outgoing.end();
    });

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** Poll `read` until `done` accepts its value or `deadlineMs` passes; returns the last value. */
const pollUntil = async <T>(read: () => Promise<T>, done: (value: T) => boolean, deadlineMs: number): Promise<T> => {
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

/** Whether a TCP connect to `host:port` succeeds when made as `user` (root's own when absent). */
const connectsAs = async (user: string | undefined, host: string, port: number): Promise<string> => {
    const script = `require("net").connect(${String(port)}, ${JSON.stringify(host)}).setTimeout(4000).on("connect", () => { console.log("connected"); process.exit(0); }).on("timeout", () => { console.log("timeout"); process.exit(0); }).on("error", (error) => { console.log(error.code); process.exit(0); })`;
    const command =
        user === undefined
            ? [process.execPath, "-e", script]
            : [tool("setpriv"), `--reuid=${user}`, `--regid=${user}`, "--clear-groups", "--", process.execPath, "-e", script];
    const result = await run(command[0] as string, command.slice(1), { PATH: SYSTEM_PATH });

    return result.output.trim();
};

describe.sequential("lunora-hostd against real celld, Caddy and a bucket", () => {
    const endpoint = required("LUNORA_HOSTD_S3_ENDPOINT");
    let plane: FakeControlPlane;
    let box: LaneBox;
    let httpPort: number;
    let adminPort: number;
    let askPort: number;

    beforeAll(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        box = await createLaneBox();

        const created = await s3.fetch(`${endpoint}/${BUCKET}`, { method: "PUT" });

        if (!created.ok && created.status !== 409) {
            throw new Error(`could not create the lane's bucket at ${endpoint}: ${String(created.status)} ${await created.text()}`);
        }
    });

    afterAll(async () => {
        await box?.stop().catch(() => undefined);
        await plane?.close();
        await box?.remove();
    });

    it("enrols, after celld's bucket check passes", async () => {
        expect.assertions(3);

        const result = await box.enrol({ bucket: `s3://${BUCKET}`, controlPlane: plane.origin, endpoint, token: TOKEN });

        expect(result.code, result.output).toBe(0);
        expect(result.output).not.toContain(TOKEN);
        expect(plane.enrolments).toMatchObject([{ ipv4: "203.0.113.10", token: TOKEN, versions: { caddy: "v2.11.6", celld: "0.6.0" } }]);
    });

    it("holds a session with the control plane and reports its isolation", async () => {
        expect.assertions(1);

        httpPort = box.isolated ? 80 : await freePort();
        adminPort = await freePort();
        askPort = await freePort();
        patchConfig(box.configPath, (config) => {
            return {
                ...config,
                caddy: { adminAddress: `127.0.0.1:${String(adminPort)}`, askAddress: `127.0.0.1:${String(askPort)}`, httpPort, httpsPort: 443, tls: false },
            };
        });
        await box.start();
        await pollUntil(
            async () => plane.authentications,
            (count) => count > 0,
            60_000,
        );

        expect(
            plane.received.find((message) => message.type === "hello"),
            box.logs(),
        ).toMatchObject({
            boxId: plane.boxId,
            isolation: { status: box.isolated ? "enforced" : "single-trust" },
        });
    });

    it("deploys a release and serves it through Caddy", async () => {
        expect.assertions(3);

        plane.releases.set(
            "dep_lane_1",
            JSON.stringify({ bundle: Buffer.from(WORKER).toString("base64"), manifest: { bindings: [], compatibilityDate: "2026-04-01" } }),
        );
        plane.pushRoutes([{ alias: ALIAS, hostname: `${ALIAS}.${plane.hostname}` }]);

        const { progress, result } = await plane.dispatch({
            alias: ALIAS,
            crons: [],
            deploymentId: "dep_lane_1",
            kind: "deploy",
            releaseUrl: `${plane.origin}/v1/boxes/releases/dep_lane_1`,
            vars: { LANE: "1" },
        });

        expect(result, `${progress.join("\n")}\n${box.logs()}`).toMatchObject({
            ok: true,
            url: `http://${ALIAS}.${plane.hostname}${httpPort === 80 ? "" : `:${String(httpPort)}`}`,
        });

        const served = await pollUntil(
            async () =>
                viaCaddy(httpPort, `${ALIAS}.${plane.hostname}`, "/").catch((error: unknown) => {
                    return { body: String(error), status: 0 };
                }),
            (response) => response.status === 200,
            90_000,
        );

        expect(served, box.logs()).toStrictEqual({ body: "hello from the hostd lane", status: 200 });
        await expect(viaCaddy(httpPort, "nobody.example", "/")).resolves.toMatchObject({ status: 404 });
    });

    it("reports the requests Caddy served, per alias, once their minute closes", async () => {
        expect.assertions(1);

        const reported = await pollUntil(
            async () =>
                plane.received
                    .filter((message): message is ReportMessage => message.type === "report")
                    .flatMap((report) => report.perAlias.filter((entry) => entry.alias === ALIAS)),
            (entries) => entries.some((entry) => entry.requests > 0),
            150_000,
        );

        expect(
            reported.some((entry) => entry.requests > 0),
            box.logs(),
        ).toBe(true);
    });

    // The probe suite needs root and systemd (LUNORA_HOSTD_ISOLATION=1, as the CI job runs it); a local run proves the functional path.
    it.runIf(ISOLATED)("keeps the fleet away from the operator API, the edge's admin endpoints and the metadata service", async () => {
        expect.assertions(11);

        const state = JSON.parse(readFileSync(`${box.dataDir}/state.json`, "utf8")) as { fleets: Record<string, { internalPort: number }> };
        const internalPort = state.fleets[ALIAS]?.internalPort ?? 0;
        const probe = async (target: string): Promise<{ reached: boolean }> => {
            const answer = await viaCaddy(httpPort, `${ALIAS}.${plane.hostname}`, `/probe?target=${encodeURIComponent(target)}`);

            return JSON.parse(answer.body) as { reached: boolean };
        };

        // From inside the deployed app. Plain HTTP and literal addresses: these are the targets the policy must refuse.
        /* eslint-disable sonarjs/no-clear-text-protocols, sonarjs/no-hardcoded-ip -- the addresses a fleet must not reach */
        for (const target of [
            `http://127.0.0.1:${String(internalPort)}/`,
            `http://127.0.0.1:${String(adminPort)}/config/`,
            `http://127.0.0.1:${String(askPort)}/ask?domain=x`,
            "http://169.254.169.254/",
        ]) {
            // eslint-disable-next-line no-await-in-loop -- one probe at a time
            await expect(probe(target), target).resolves.toMatchObject({ reached: false });
        }

        // As the fleet user directly: the egress table, not just the runtime, refuses. Root is the control.
        await expect(connectsAs(undefined, "127.0.0.1", internalPort)).resolves.toBe("connected");
        await expect(connectsAs("lunora-fleet", "127.0.0.1", internalPort)).resolves.not.toBe("connected");
        await expect(connectsAs("lunora-fleet", "127.0.0.1", adminPort)).resolves.not.toBe("connected");
        await expect(connectsAs("lunora-fleet", "169.254.169.254", 80)).resolves.not.toBe("connected");
        /* eslint-enable sonarjs/no-clear-text-protocols, sonarjs/no-hardcoded-ip */

        // The bucket stays reachable for the fleet.
        const bucket = new URL(endpoint);

        await expect(connectsAs("lunora-fleet", bucket.hostname, Number(bucket.port))).resolves.toBe("connected");

        // The nftables table is loaded.
        expect(execFileSync(tool("nft"), ["list", "table", "inet", "lunora_hostd"], { encoding: "utf8" })).toContain("meta skuid != ");
        expect(internalPort).toBeGreaterThan(0);
    });

    it.runIf(ISOLATED)("runs the fleet as lunora-fleet without capabilities in its own memory cgroup, and Caddy with only port binding", async () => {
        expect.assertions(6);

        const fleetUid = execFileSync(tool("id"), ["-u", "lunora-fleet"], { encoding: "utf8" }).trim();
        const [node] = execFileSync(tool("pgrep"), ["-u", fleetUid, "-f", "celld"], { encoding: "utf8" }).trim().split("\n");
        const [caddy] = execFileSync(tool("pgrep"), ["-x", "caddy"], { encoding: "utf8" }).trim().split("\n");
        const status = (pid: string | undefined): string => readFileSync(`/proc/${pid ?? "self"}/status`, "utf8");
        const field = (text: string, name: string): string => new RegExp(String.raw`^${name}:\s*(\S+)`, "mu").exec(text)?.[1] ?? "";
        const cgroup = readFileSync(`/proc/${node ?? "self"}/cgroup`, "utf8").trim();

        expect(field(status(node), "Uid")).toBe(fleetUid);
        expect([field(status(node), "CapEff"), field(status(node), "NoNewPrivs")]).toStrictEqual(["0000000000000000", "1"]);
        expect(cgroup).toMatch(new RegExp(String.raw`/lunora-hostd\.service/fleet-${ALIAS}$`, "u"));
        expect(Number(readFileSync(`/sys/fs/cgroup${cgroup.slice(3)}/memory.max`, "utf8"))).toBeGreaterThan(0);
        // CAP_NET_BIND_SERVICE is bit 10.
        expect(field(status(caddy), "CapEff")).toBe("0000000000000400");
        expect(existsSync("/etc/lunora-hostd/box.key") && execFileSync(tool("stat"), ["-c", "%U %a", "/etc/lunora-hostd"], { encoding: "utf8" }).trim()).toBe(
            "lunora-hostd 700",
        );
    });

    it("destroys the fleet and deletes exactly its prefix with deleteData", async () => {
        expect.assertions(3);

        await expect(
            pollUntil(
                async () => listKeys(endpoint, `fleets/${ALIAS}/`),
                (keys) => keys.length > 0,
                10_000,
            ),
        ).resolves.not.toHaveLength(0);

        const { progress, result } = await plane.dispatch({ alias: ALIAS, deleteData: true, kind: "destroy" });

        expect(result, progress.join("\n")).toMatchObject({ ok: true });
        await expect(listKeys(endpoint, `fleets/${ALIAS}/`)).resolves.toStrictEqual([]);
    });

    it("stops cleanly on SIGTERM", async () => {
        expect.assertions(1);

        await expect(box.stop()).resolves.toBe(0);
    });
});
