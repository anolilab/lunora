/**
 * The `lunora-hostd` command line, run as the built binary. The command-line
 * cases use the default build; `install-release` uses a build that trusts the
 * test release key (`helpers/test-release.ts`).
 */
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HostdReleaseManifest } from "../src/release";
import { signReleaseManifest } from "../src/release-verify";
import { buildHostd, execHostd, runHostd } from "./helpers/hostd-binary";
import { createTestReleaseKey } from "./helpers/test-release";

/** No box is enrolled: the configuration the commands read does not exist. */
const ENVIRONMENT = { LUNORA_HOSTD_CONFIG: "/nonexistent/lunora-hostd/config.json" };

describe("lunora-hostd", () => {
    let hostd: string;

    const run = (argv: string[]) => runHostd(hostd, argv, ENVIRONMENT);

    beforeAll(() => {
        hostd = buildHostd();
    }, 600_000);

    it("prints the package version", () => {
        expect.assertions(1);

        const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

        expect(run(["--version"])).toStrictEqual({ code: 0, stderr: "", stdout: `${version}\n` });
    });

    it("prints help naming every command", () => {
        expect.assertions(4);

        const result = run(["--help"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/lunora-hostd enrol/u);
        expect(result.stdout).toMatch(/lunora-hostd run/u);
        expect(result.stdout).toMatch(/lunora-hostd status/u);
    });

    it("exits non-zero with help for an unknown command or none", () => {
        expect.assertions(4);

        const none = run([]);
        const unknown = run(["frobnicate"]);

        expect(none.code).toBe(1);
        expect(none.stderr).toMatch(/Usage/u);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toMatch(/Usage/u);
    });

    it("refuses to run or report status before the box is enrolled", () => {
        expect.assertions(4);

        const daemon = run(["run"]);
        const status = run(["status"]);

        expect(daemon.code).toBe(1);
        expect(daemon.stderr).toMatch(/enrol this box first/u);
        expect(status.code).toBe(1);
        expect(status.stderr).toMatch(/enrol this box first/u);
    });

    it("does not echo a token passed on the command line", () => {
        expect.assertions(2);

        const result = run(["enrol", "--token", "secret-token"]);

        expect(result.code).toBe(1);
        expect(result.stderr).not.toMatch(/secret-token/u);
    });
});

describe("lunora-hostd install-release", () => {
    const key = createTestReleaseKey();
    let hostd: string;
    let root: string;
    let from: string;
    let installDirectory: string;
    let manifestPath: string;
    let manifest: HostdReleaseManifest;

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

    const sign = (signed: HostdReleaseManifest, privateKey: KeyObject = key.privateKey): void => {
        writeFileSync(manifestPath, JSON.stringify(signReleaseManifest(signed, privateKey)));
    };

    const install = async (...flags: string[]) =>
        execHostd(hostd, ["install-release", manifestPath, "--from", from, "--install-dir", installDirectory, "--platform", "linux-x64", ...flags]);

    beforeAll(() => {
        hostd = buildHostd({ trustedKeys: key.trustedKeys, version: "1.0.0" });
    }, 600_000);

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-install-"));
        from = join(root, "download");
        installDirectory = join(root, "opt");
        mkdirSync(from);
        mkdirSync(installDirectory);
        manifestPath = join(root, "manifest.json");
        manifest = {
            caddy: { artifacts: [artifact("caddy", script("v2.11.6 h1:test"))], modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.11.6" },
            celld: { artifacts: [artifact("celld", gzipSync(script("celld 0.6.0")), "gzip")], version: "v0.6.0" },
            createdAt: "2026-10-02T12:00:00.000Z",
            hostd: { artifacts: [artifact("lunora-hostd", script("1.0.0"))], version: "1.0.0" },
            releaseId: "hostd-v1_0_0",
            schema: 1,
        };
        sign(manifest);
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

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
        sign({ ...manifest, hostd: { ...manifest.hostd, version: "1.0.0-rc.1" }, releaseId: "hostd-v1_0_0-rc_1" });

        const refused = await install();

        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(/lunora-hostd 1\.0\.0-rc\.1 is older than the installed 1\.0\.0/u);

        const forced = await install("--allow-downgrade");

        expect(forced.code).toBe(0);
        expect(readlinkSync(join(installDirectory, "current"))).toBe("hostd-v1_0_0-rc_1");
    });

    it("refuses a manifest no compiled-in key signed, and installs nothing", async () => {
        expect.assertions(3);

        sign(manifest, generateKeyPairSync("ed25519").privateKey);

        const result = await install();

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
