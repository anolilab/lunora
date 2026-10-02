import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    it("does not echo the token when enrol is missing its bucket", async () => {
        expect.assertions(2);

        const result = await run(["enrol", "--token", "secret-token"]);

        expect(result.code).toBe(1);
        expect(result.stderr).not.toMatch(/secret-token/u);
    });
});

describe("lunora-hostd verify-release", () => {
    let root: string;
    let trustedKeys: Record<string, string>;
    let manifestPath: string;

    const artifact = (name: string, bytes: string) => {
        writeFileSync(join(root, name), bytes);

        return {
            platform: "linux-x64" as const,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: Buffer.byteLength(bytes),
            url: `https://github.com/anolilab/lunora/releases/download/hostd-v1.0.0/${name}`,
        };
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-verify-"));

        const keys = generateKeyPairSync("ed25519");
        const manifest: HostdReleaseManifest = {
            caddy: { artifacts: [artifact("caddy-linux-x64.gz", "caddy")], modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.11.6" },
            celld: { artifacts: [artifact("celld.gz", "celld")], version: "v0.6.0" },
            createdAt: "2026-10-02T12:00:00.000Z",
            hostd: { artifacts: [artifact("lunora-hostd-linux-x64", "hostd")], version: "1.0.0" },
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

    const files = (): string[] => [
        "--platform",
        "linux-x64",
        "--hostd",
        join(root, "lunora-hostd-linux-x64"),
        "--celld",
        join(root, "celld.gz"),
        "--caddy",
        join(root, "caddy-linux-x64.gz"),
    ];

    it("prints the release id of a manifest signed by a trusted key whose files match", async () => {
        expect.assertions(1);

        await expect(run(["verify-release", manifestPath, ...files()], { trustedKeys })).resolves.toStrictEqual({
            code: 0,
            stderr: "",
            stdout: "hostd-v1_0_0\n",
        });
    });

    it("refuses a manifest no compiled-in key signed", async () => {
        expect.assertions(2);

        const result = await run(["verify-release", manifestPath, ...files()]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/does not verify: UNKNOWN_KEY/u);
    });

    it("refuses a downloaded file the manifest does not pin", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "celld.gz"), "cellD");

        const result = await run(["verify-release", manifestPath, ...files()], { trustedKeys });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/celld .* does not match the manifest: HASH_MISMATCH/u);
    });
});
