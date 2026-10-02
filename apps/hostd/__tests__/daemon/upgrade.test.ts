/**
 * The `upgrade` job against a test-signed release manifest: what verifies is
 * installed and the children restart onto it; what does not verify — unsigned,
 * tampered, a placeholder key, another release, a bad artifact — changes
 * nothing.
 */
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "../../src/daemon/log";
import { Daemon } from "../../src/daemon/run";
import type { HostdReleaseEnvelope, HostdReleaseManifest } from "../../src/release";
import { HOSTD_TRUSTED_RELEASE_KEYS } from "../../src/release";
import { releaseKeyId, signReleaseManifest } from "../../src/release-verify";
import type { TestBox } from "./helpers/box";
import { createTestBox } from "./helpers/box";
import { celldInvocations, writeFakeBinaries } from "./helpers/fake-binaries";
import { FakeControlPlane } from "./helpers/fake-control-plane";

const sha256 = async (bytes: Uint8Array): Promise<string> => Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");

interface Artifacts {
    /** Download URL → bytes. */
    files: Map<string, Uint8Array>;
    manifest: HostdReleaseManifest;
}

/** New celld (gzipped, as upstream ships it), Caddy and hostd builds, and the manifest pinning them. */
const buildRelease = async (box: TestBox): Promise<Artifacts> => {
    const fresh = writeFakeBinaries(join(box.root, "new-bin"), box.records);
    const celld = gzipSync(readFileSync(fresh.celld, "utf8").replace("celld 0.6.0", "celld 0.7.0"));
    const caddy = Buffer.from(readFileSync(fresh.caddy, "utf8").replace("v2.11.6 h1:fake", "v2.12.0 h1:fake"));
    const hostd = Buffer.from(`#!${process.execPath}\nconsole.log("9.9.9");\n`);
    const files = new Map<string, Uint8Array>([
        ["https://artifacts.test/caddy.gz", caddy],
        ["https://artifacts.test/celld.gz", celld],
        ["https://artifacts.test/lunora-hostd", hostd],
    ]);
    const entry = async (url: string, compression?: "gzip") => {
        const bytes = files.get(url) as Uint8Array;
        const base = { sha256: await sha256(bytes), size: bytes.byteLength, url, ...(compression === undefined ? {} : { compression }) };

        return [
            { platform: "linux-arm64" as const, ...base },
            { platform: "linux-x64" as const, ...base },
        ];
    };

    return {
        files,
        manifest: {
            caddy: { artifacts: await entry("https://artifacts.test/caddy.gz"), modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.12.0" },
            celld: { artifacts: await entry("https://artifacts.test/celld.gz", "gzip"), version: "v0.7.0" },
            createdAt: "2026-10-02T12:00:00.000Z",
            hostd: { artifacts: await entry("https://artifacts.test/lunora-hostd"), version: "9.9.9" },
            releaseId: "hostd-v9_9_9",
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

        // The daemon runs as an installed binary, so an upgrade may replace it.
        const hostdPath = join(box.root, "bin", "lunora-hostd");

        writeFileSync(hostdPath, `#!${process.execPath}\nconsole.log("0.0.0");\n`);
        chmodSync(hostdPath, 0o755);
        box.config.binaries.hostd = hostdPath;

        release = await buildRelease(box);

        const keys = generateKeyPairSync("ed25519");

        privateKey = keys.privateKey;
        trustedKeys = { [releaseKeyId(keys.publicKey)]: keys.publicKey.export({ format: "pem", type: "spki" }) };

        const artifactFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);
            const bytes = release.files.get(url);

            if (bytes !== undefined) {
                return new Response(Uint8Array.from(bytes));
            }

            return globalThis.fetch(input, init);
        };

        daemon = new Daemon({ config: box.config, fetch: artifactFetch, logger: silentLogger, trustedKeys });
        running = daemon.run();
        await plane.authenticated();
    });

    afterEach(async () => {
        daemon.stop();
        await running;
        await plane.close();
        box.cleanup();
    });

    it("installs a verified release, restarts the fleets, then exits for systemd", async () => {
        expect.assertions(7);

        plane.releases.set("dep_1", JSON.stringify({ bundle: "AA==", manifest: { bindings: [] } }));
        await plane.dispatch({
            alias: "app",
            crons: [],
            deploymentId: "dep_1",
            kind: "deploy",
            releaseUrl: `${plane.origin}/v1/boxes/releases/dep_1`,
            vars: {},
        });

        const nodesBefore = celldInvocations(box.records).filter((run) => run.argv[0] === "--bucket").length;

        publish(signReleaseManifest(release.manifest, privateKey));

        const { progress, result } = await upgrade();

        expect(result).toStrictEqual({ jobId: "job_2", ok: true, type: "result" });
        expect(progress.some((line) => line.startsWith("manifest verified"))).toBe(true);
        expect(execFileSync(box.config.binaries.celld, ["--version"], { encoding: "utf8" }).trim()).toBe("celld 0.7.0");
        expect(execFileSync(box.config.binaries.caddy, ["version"], { encoding: "utf8" }).trim()).toBe("v2.12.0 h1:fake");
        expect(execFileSync(box.config.binaries.hostd as string, [], { encoding: "utf8" }).trim()).toBe("9.9.9");
        expect(celldInvocations(box.records).filter((run) => run.argv[0] === "--bucket")).toHaveLength(nodesBefore + 1);

        // hostd replaced itself: the session ends after the result went out, and run() resolves 0.
        await expect(running).resolves.toBe(0);
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
        expect(execFileSync(box.config.binaries.celld, ["--version"], { encoding: "utf8" }).trim()).toBe("celld 0.6.0");
    });

    it("refuses a manifest for another release than the job names", async () => {
        expect.assertions(1);

        publish(signReleaseManifest(release.manifest, privateKey), "hostd-v1_0_0");

        const { result } = await upgrade("hostd-v1_0_0");

        expect(result.error).toMatchObject({ code: "UPGRADE_REFUSED", message: expect.stringMatching(/not hostd-v1_0_0/u) });
    });

    it("refuses an artifact whose bytes do not match the manifest, before installing anything", async () => {
        expect.assertions(3);

        publish(signReleaseManifest(release.manifest, privateKey));
        // Same length, different bytes: passes the size check, fails the hash.
        const caddy = release.files.get("https://artifacts.test/caddy.gz") as Uint8Array;

        release.files.set(
            "https://artifacts.test/caddy.gz",
            Uint8Array.from(caddy, (byte, index) => (index === 10 ? (byte + 1) % 256 : byte)),
        );

        const { result } = await upgrade();

        expect(result.error).toMatchObject({ code: "ARTIFACT_INVALID", message: expect.stringMatching(/HASH_MISMATCH/u) });
        expect(execFileSync(box.config.binaries.celld, ["--version"], { encoding: "utf8" }).trim()).toBe("celld 0.6.0");
        expect(execFileSync(box.config.binaries.caddy, ["version"], { encoding: "utf8" }).trim()).toBe("v2.11.6 h1:fake");
    });

    it("trusts only the compiled-in keys by default, which verify nothing yet", async () => {
        expect.assertions(3);

        daemon.stop();
        await running;
        daemon = new Daemon({ config: box.config, logger: silentLogger });
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
