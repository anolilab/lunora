import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HostdReleaseManifest } from "../src/release";
import { releaseKeyId, signReleaseManifest } from "../src/release-verify";
import type { BinDependencies } from "../src/run-bin";
import { runBin } from "../src/run-bin";

const run = async (argv: string[], dependencies: BinDependencies = {}): Promise<{ code: number; stderr: string; stdout: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runBin(
        argv,
        {
            stderr: (text) => {
                stderr += text;
            },
            stdout: (text) => {
                stdout += text;
            },
        },
        { environment: { LUNORA_HOSTD_CONFIG: "/nonexistent/lunora-hostd/config.json" }, ...dependencies },
    );

    return { code, stderr, stdout };
};

describe(runBin, () => {
    it("prints the package version", async () => {
        expect.assertions(1);

        const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

        await expect(run(["--version"])).resolves.toStrictEqual({ code: 0, stderr: "", stdout: `${version}\n` });
    });

    it("prints help naming every command", async () => {
        expect.assertions(4);

        const result = await run(["--help"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/lunora-hostd enrol/u);
        expect(result.stdout).toMatch(/lunora-hostd run/u);
        expect(result.stdout).toMatch(/lunora-hostd status/u);
    });

    it("exits non-zero with help for an unknown command or none", async () => {
        expect.assertions(4);

        const none = await run([]);
        const unknown = await run(["frobnicate"]);

        expect(none.code).toBe(1);
        expect(none.stderr).toMatch(/Usage/u);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toMatch(/Usage/u);
    });

    it("refuses to run or report status before the box is enrolled", async () => {
        expect.assertions(4);

        const daemon = await run(["run"]);
        const status = await run(["status"]);

        expect(daemon.code).toBe(1);
        expect(daemon.stderr).toMatch(/enrol this box first/u);
        expect(status.code).toBe(1);
        expect(status.stderr).toMatch(/enrol this box first/u);
    });

    it("does not echo a token passed on the command line", async () => {
        expect.assertions(2);

        const result = await run(["enrol", "--token", "secret-token"]);

        expect(result.code).toBe(1);
        expect(result.stderr).not.toMatch(/secret-token/u);
    });
});

describe("lunora-hostd install-release", () => {
    let root: string;
    let from: string;
    let installDirectory: string;
    let trustedKeys: Record<string, string>;
    let manifestPath: string;

    /** Write `bytes` as the downloaded `name`, and the manifest entry pinning them. */
    const artifact = (name: string, bytes: Uint8Array, compression?: "gzip") => {
        writeFileSync(join(from, name), bytes);

        return {
            platform: "linux-x64" as const,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
            url: `https://github.com/anolilab/lunora/releases/download/hostd-v1.0.0/${name}`,
            ...(compression === undefined ? {} : { compression }),
        };
    };

    const script = (printed: string): Buffer => Buffer.from(`#!/bin/sh\necho "${printed}"\n`);

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-install-"));
        from = join(root, "download");
        installDirectory = join(root, "opt");
        mkdirSync(from);
        mkdirSync(installDirectory);

        const keys = generateKeyPairSync("ed25519");
        const manifest: HostdReleaseManifest = {
            caddy: { artifacts: [artifact("caddy", script("v2.11.6 h1:test"))], modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.11.6" },
            celld: { artifacts: [artifact("celld", gzipSync(script("celld 0.6.0")), "gzip")], version: "v0.6.0" },
            createdAt: "2026-10-02T12:00:00.000Z",
            hostd: { artifacts: [artifact("lunora-hostd", script("1.0.0"))], version: "1.0.0" },
            releaseId: "hostd-v1_0_0",
            schema: 1,
        };

        trustedKeys = { [releaseKeyId(keys.publicKey)]: keys.publicKey.export({ format: "pem", type: "spki" }) };
        manifestPath = join(root, "manifest.json");
        writeFileSync(manifestPath, JSON.stringify(signReleaseManifest(manifest, keys.privateKey)));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const install = async (dependencies?: BinDependencies) =>
        run(["install-release", manifestPath, "--from", from, "--install-dir", installDirectory, "--platform", "linux-x64"], dependencies ?? { trustedKeys });

    it("installs a release signed by a trusted key whose files match, and switches current to it", async () => {
        expect.assertions(4);

        await expect(install()).resolves.toMatchObject({ code: 0, stdout: "hostd-v1_0_0\n" });
        expect(readlinkSync(join(installDirectory, "current"))).toBe("hostd-v1_0_0");
        // Decompressed, executable, with the verified manifest beside the binaries.
        expect(execFileSync(join(installDirectory, "current", "celld"), { encoding: "utf8" })).toBe("celld 0.6.0\n");
        expect(JSON.parse(readFileSync(join(installDirectory, "current", "manifest.json"), "utf8"))).toMatchObject({ manifest: { releaseId: "hostd-v1_0_0" } });
    });

    it("does nothing for the release that already runs", async () => {
        expect.assertions(2);

        await install();

        const again = await install();

        expect(again.code).toBe(0);
        expect(again.stderr).toMatch(/hostd-v1_0_0 is the one running; nothing to install/u);
    });

    it("refuses an older release unless --allow-downgrade is given", async () => {
        expect.assertions(4);

        await install();

        const keys = generateKeyPairSync("ed25519");
        const older = JSON.parse(readFileSync(manifestPath, "utf8")) as { manifest: HostdReleaseManifest };

        trustedKeys = { [releaseKeyId(keys.publicKey)]: keys.publicKey.export({ format: "pem", type: "spki" }) };
        writeFileSync(
            manifestPath,
            JSON.stringify(
                signReleaseManifest(
                    { ...older.manifest, hostd: { ...older.manifest.hostd, version: "1.0.0-rc.1" }, releaseId: "hostd-v1_0_0-rc_1" },
                    keys.privateKey,
                ),
            ),
        );

        const refused = await install();

        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(/lunora-hostd 1\.0\.0-rc\.1 is older than the installed 1\.0\.0/u);

        const forced = await run(
            ["install-release", manifestPath, "--from", from, "--install-dir", installDirectory, "--platform", "linux-x64", "--allow-downgrade"],
            { trustedKeys },
        );

        expect(forced.code).toBe(0);
        expect(readlinkSync(join(installDirectory, "current"))).toBe("hostd-v1_0_0-rc_1");
    });

    it("refuses a manifest no compiled-in key signed, and installs nothing", async () => {
        expect.assertions(3);

        const result = await install({});

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/does not verify: UNKNOWN_KEY/u);
        expect(readdirSync(installDirectory)).toStrictEqual([]);
    });

    it("refuses a downloaded file the manifest does not pin, and installs nothing", async () => {
        expect.assertions(3);

        writeFileSync(join(from, "caddy"), script("v2.11.7 h1:test"));

        const result = await install();

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/caddy: (?:SIZE|HASH)_MISMATCH/u);
        expect(readdirSync(installDirectory)).toStrictEqual([]);
    });
});
