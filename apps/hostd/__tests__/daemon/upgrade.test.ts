/**
 * The `upgrade` job against a test-signed release manifest: what verifies is
 * installed as `{installDir}/{releaseId}/`, `current` switches to it, and the
 * box restarts onto it; what does not verify — unsigned, tampered, a
 * placeholder key, another release, a bad artifact — changes nothing.
 */
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { binaryPaths } from "../../src/daemon/config";
import { silentLogger } from "../../src/daemon/log";
import { Daemon } from "../../src/daemon/run";
import type { HostdReleaseEnvelope, HostdReleaseManifest } from "../../src/release";
import { HOSTD_TRUSTED_RELEASE_KEYS } from "../../src/release";
import { releaseKeyId, signReleaseManifest } from "../../src/release-verify";
import type { TestBox } from "./helpers/box";
import { createTestBox, INITIAL_RELEASE, unisolatedSystem } from "./helpers/box";
import { celldInvocations, writeFakeBinaries } from "./helpers/fake-binaries";
import { FakeControlPlane } from "./helpers/fake-control-plane";

const sha256 = async (bytes: Uint8Array): Promise<string> => Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");

interface Artifacts {
    /** Download URL → bytes. */
    files: Map<string, Uint8Array>;
    manifest: HostdReleaseManifest;
}

/**
 * New celld (gzipped, as upstream ships it), Caddy and hostd builds, and the
 * manifest pinning them. `hostdVersion` is the version the new hostd reports:
 * the running one (`0.0.0` in tests) means hostd itself does not change.
 */
const buildRelease = async (box: TestBox, releaseId = "hostd-v9_9_9", hostdVersion = "9.9.9"): Promise<Artifacts> => {
    const fresh = writeFakeBinaries(join(box.root, `new-bin-${releaseId}`), box.records);
    const celld = gzipSync(readFileSync(fresh.celld, "utf8").replace("celld 0.6.0", "celld 0.7.0"));
    const caddy = Buffer.from(readFileSync(fresh.caddy, "utf8").replace("v2.11.6 h1:fake", "v2.12.0 h1:fake"));
    const hostd = Buffer.from(`#!${process.execPath}\nconsole.log(${JSON.stringify(hostdVersion)});\n`);
    const base = `https://artifacts.test/${releaseId}`;
    const files = new Map<string, Uint8Array>([
        [`${base}/caddy.gz`, caddy],
        [`${base}/celld.gz`, celld],
        [`${base}/lunora-hostd`, hostd],
    ]);
    const entry = async (url: string, compression?: "gzip") => {
        const bytes = files.get(url) as Uint8Array;
        const pinned = { sha256: await sha256(bytes), size: bytes.byteLength, url, ...(compression === undefined ? {} : { compression }) };

        return [
            { platform: "linux-arm64" as const, ...pinned },
            { platform: "linux-x64" as const, ...pinned },
        ];
    };

    return {
        files,
        manifest: {
            caddy: { artifacts: await entry(`${base}/caddy.gz`), modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.12.0" },
            celld: { artifacts: await entry(`${base}/celld.gz`, "gzip"), version: "v0.7.0" },
            createdAt: "2026-10-02T12:00:00.000Z",
            hostd: { artifacts: await entry(`${base}/lunora-hostd`), version: hostdVersion },
            releaseId,
            schema: 1,
        },
    };
};

describe("the upgrade job", () => {
    let plane: FakeControlPlane;
    let box: TestBox;
    let daemon: Daemon;
    let running: Promise<number>;
    let release: Artifacts;
    /** Every artifact a test published, by URL. */
    let published: Map<string, Uint8Array>;
    let trustedKeys: Record<string, string>;
    let privateKey: KeyObject;

    const publish = (envelope: unknown, releaseId = "hostd-v9_9_9"): void => {
        plane.manifests.set(releaseId, JSON.stringify(envelope));
    };

    const upgrade = async (releaseId = "hostd-v9_9_9") =>
        plane.dispatch({ kind: "upgrade", manifestUrl: `${plane.origin}/v1/hostd/releases/${releaseId}/manifest`, releaseId });

    beforeEach(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        box = await createTestBox(plane);
        release = await buildRelease(box);
        published = release.files;

        const keys = generateKeyPairSync("ed25519");

        privateKey = keys.privateKey;
        trustedKeys = { [releaseKeyId(keys.publicKey)]: keys.publicKey.export({ format: "pem", type: "spki" }) };

        const artifactFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);
            const bytes = published.get(url);

            if (bytes !== undefined) {
                return new Response(Uint8Array.from(bytes));
            }

            return globalThis.fetch(input, init);
        };

        daemon = new Daemon({ config: box.config, fetch: artifactFetch, isolation: unisolatedSystem(), logger: silentLogger, trustedKeys });
        running = daemon.run();
        await plane.authenticated();
    });

    afterEach(async () => {
        daemon.stop();
        await running;
        await plane.close();
        box.cleanup();
    });

    const deployApp = async (): Promise<void> => {
        plane.releases.set("dep_1", JSON.stringify({ bundle: "AA==", manifest: { bindings: [] } }));
        await plane.dispatch({
            alias: "app",
            crons: [],
            deploymentId: "dep_1",
            kind: "deploy",
            releaseUrl: `${plane.origin}/v1/boxes/releases/dep_1`,
            vars: {},
        });
    };

    const nodeStarts = (): number => celldInvocations(box.records).filter((run) => run.argv[0] === "--bucket").length;

    const versionOf = (binary: string, args: string[]): string => execFileSync(binary, args, { encoding: "utf8" }).trim();

    it("installs a verified release beside the old one, switches current, then exits for systemd", async () => {
        expect.assertions(9);

        await deployApp();

        const nodesBefore = nodeStarts();
        const binaries = binaryPaths(box.config);

        publish(signReleaseManifest(release.manifest, privateKey));

        const { progress, result } = await upgrade();

        expect(result).toStrictEqual({ jobId: "job_2", ok: true, type: "result" });
        expect(progress.some((line) => line.startsWith("manifest verified"))).toBe(true);
        expect(readlinkSync(join(box.config.installDir, "current"))).toBe("hostd-v9_9_9");
        expect(versionOf(binaries.celld, ["--version"])).toBe("celld 0.7.0");
        expect(versionOf(binaries.caddy, ["version"])).toBe("v2.12.0 h1:fake");
        expect(versionOf(binaries.hostd, [])).toBe("9.9.9");
        // The release that ran before stays, for a manual rollback; the manifest is kept with the new one.
        expect(existsSync(join(box.config.installDir, INITIAL_RELEASE, "celld"))).toBe(true);
        expect(JSON.parse(readFileSync(join(box.config.installDir, "hostd-v9_9_9", "manifest.json"), "utf8"))).toMatchObject({
            manifest: { releaseId: "hostd-v9_9_9" },
        });

        // hostd replaced itself: no fleet restarts in place (the new hostd starts them), and run() resolves 0.
        await expect(running.then((code) => [code, nodeStarts() - nodesBefore])).resolves.toStrictEqual([0, 0]);
    });

    it("restarts the fleets in place when hostd itself is unchanged, and keeps only the previous release", async () => {
        expect.assertions(6);

        await deployApp();

        const nodesBefore = nodeStarts();
        const first = await buildRelease(box, "hostd-v0_0_1", "0.0.0");
        const second = await buildRelease(box, "hostd-v0_0_2", "0.0.0");

        published = new Map([...first.files, ...second.files]);
        publish(signReleaseManifest(first.manifest, privateKey), "hostd-v0_0_1");
        publish(signReleaseManifest(second.manifest, privateKey), "hostd-v0_0_2");

        await expect(upgrade("hostd-v0_0_1")).resolves.toMatchObject({ result: { ok: true } });
        expect(nodeStarts()).toBe(nodesBefore + 1);

        await expect(upgrade("hostd-v0_0_2")).resolves.toMatchObject({ result: { ok: true } });
        expect(readlinkSync(join(box.config.installDir, "current"))).toBe("hostd-v0_0_2");
        // v0_0_1 ran before v0_0_2 and stays; the first release is gone.
        expect([INITIAL_RELEASE, "hostd-v0_0_1"].map((id) => existsSync(join(box.config.installDir, id)))).toStrictEqual([false, true]);

        // Asking for the release that runs changes nothing.
        await expect(upgrade("hostd-v0_0_2")).resolves.toMatchObject({
            progress: expect.arrayContaining(["release hostd-v0_0_2 is the one running; nothing to install"]),
            result: { ok: true },
        });
    });

    it.each([
        [
            "unsigned",
            (envelope: HostdReleaseEnvelope) => {
                return { ...envelope, signature: "A".repeat(86) };
            },
            /BAD_SIGNATURE/u,
        ],
        [
            "tampered",
            (envelope: HostdReleaseEnvelope) => {
                return { ...envelope, manifest: { ...envelope.manifest, createdAt: "2026-10-03T12:00:00.000Z" } };
            },
            /BAD_SIGNATURE/u,
        ],
        [
            "placeholder-keyed",
            (envelope: HostdReleaseEnvelope) => {
                return { ...envelope, keyId: "ed25519-placeholder" };
            },
            /UNKNOWN_KEY/u,
        ],
    ])("refuses a %s manifest and changes nothing", async (_name, mutate, reason) => {
        expect.assertions(2);

        publish(mutate(signReleaseManifest(release.manifest, privateKey)));

        const { result } = await upgrade();

        expect(result.error).toMatchObject({ code: "UPGRADE_REFUSED", message: expect.stringMatching(reason) });
        expect(versionOf(binaryPaths(box.config).celld, ["--version"])).toBe("celld 0.6.0");
    });

    it("refuses a manifest for another release than the job names", async () => {
        expect.assertions(1);

        publish(signReleaseManifest(release.manifest, privateKey), "hostd-v1_0_0");

        const { result } = await upgrade("hostd-v1_0_0");

        expect(result.error).toMatchObject({ code: "UPGRADE_REFUSED", message: expect.stringMatching(/not hostd-v1_0_0/u) });
    });

    it("refuses an artifact whose bytes do not match the manifest, before installing anything", async () => {
        expect.assertions(5);

        publish(signReleaseManifest(release.manifest, privateKey));
        // Same length, different bytes: passes the size check, fails the hash.
        const caddy = release.files.get("https://artifacts.test/hostd-v9_9_9/caddy.gz") as Uint8Array;

        release.files.set(
            "https://artifacts.test/hostd-v9_9_9/caddy.gz",
            Uint8Array.from(caddy, (byte, index) => (index === 10 ? (byte + 1) % 256 : byte)),
        );

        const { result } = await upgrade();

        expect(result.error).toMatchObject({ code: "ARTIFACT_INVALID", message: expect.stringMatching(/HASH_MISMATCH/u) });
        expect(versionOf(binaryPaths(box.config).celld, ["--version"])).toBe("celld 0.6.0");
        expect(versionOf(binaryPaths(box.config).caddy, ["version"])).toBe("v2.11.6 h1:fake");
        expect(readlinkSync(join(box.config.installDir, "current"))).toBe(INITIAL_RELEASE);
        expect(["hostd-v9_9_9", "hostd-v9_9_9.partial"].map((name) => existsSync(join(box.config.installDir, name)))).toStrictEqual([false, false]);
    });

    it("trusts only the compiled-in keys by default, which verify nothing yet", async () => {
        expect.assertions(3);

        daemon.stop();
        await running;
        daemon = new Daemon({ config: box.config, isolation: unisolatedSystem(), logger: silentLogger });
        running = daemon.run();
        await plane.authenticated(2);

        const envelope = signReleaseManifest(release.manifest, privateKey);

        publish(envelope);

        await expect(upgrade()).resolves.toMatchObject({ result: { error: { code: "UPGRADE_REFUSED", message: expect.stringMatching(/UNKNOWN_KEY/u) } } });

        // The placeholder entry is pinned, and refused as a placeholder rather than tried as a key.
        publish({ ...envelope, keyId: "ed25519-placeholder" });

        await expect(upgrade()).resolves.toMatchObject({ result: { error: { code: "UPGRADE_REFUSED", message: expect.stringMatching(/PLACEHOLDER_KEY/u) } } });

        expect(Object.keys(HOSTD_TRUSTED_RELEASE_KEYS)).toStrictEqual(["ed25519-placeholder"]);
    });
});
