/**
 * `install.sh` run for real, unprivileged: its own functions, sourced, against
 * a test-signed release served from a local directory instead of GitHub. Only
 * what needs root or the network is replaced — `fetch` (a copy from that
 * directory), `as_hostd` (no uid change), `trusted_key` (the test's key) and
 * the paths. The OpenSSL signature check, the hash check of the bootstrap
 * binary and `lunora-hostd install-release` (a build trusting the test's key)
 * all run as they do on a box.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { currentPlatform } from "../src/daemon/release-install";
import type { HostdReleaseEnvelope } from "../src/release";
import type { TestReleaseKey } from "./helpers/test-release";
import { buildTestHostd, createTestReleaseKey, signTestRelease } from "./helpers/test-release";

const INSTALL_SCRIPT = new URL("../install/install.sh", import.meta.url).pathname;

const DOWNLOADS = "https://github.com/anolilab/lunora/releases/download";

const script = (printed: string): Buffer => Buffer.from(`#!/bin/sh\necho "${printed}"\n`);

/** Answer each prompt once, as a person would: when it shows, a moment after (past `read -s` turning the echo off). */
const answerPrompts = (child: ChildProcessWithoutNullStreams, answers: ReadonlyArray<readonly [RegExp, string]>): { text: string } => {
    const output = { text: "" };
    const pending = [...answers];

    child.stdout.on("data", (chunk: Buffer) => {
        output.text += chunk.toString();

        const due = pending.filter(([prompt]) => prompt.test(output.text));

        for (const entry of due) {
            pending.splice(pending.indexOf(entry), 1);
            setTimeout(() => {
                child.stdin.write(entry[1]);
            }, 200);
        }
    });

    return output;
};

describe("install.sh, installing a release", () => {
    let root: string;
    let key: TestReleaseKey;
    let launcher: Buffer;
    let box: string;

    /** Publish `envelope` and its files as the GitHub Release `tag`. */
    const publish = (tag: string, envelope: HostdReleaseEnvelope, files: Record<string, Uint8Array>): void => {
        mkdirSync(join(root, "releases", tag), { recursive: true });
        writeFileSync(join(root, "releases", tag, "manifest.json"), JSON.stringify(envelope));

        for (const [name, bytes] of Object.entries(files)) {
            writeFileSync(join(root, "releases", tag, name), bytes);
        }
    };

    const release = (version: string): { envelope: HostdReleaseEnvelope; files: Record<string, Uint8Array> } => {
        const files = { caddy: script("v2.11.6 h1:test"), celld: gzipSync(script("celld 0.6.0")), "lunora-hostd": launcher };
        const envelope = signTestRelease(key, `hostd-v${version.replaceAll(".", "_")}`, `${DOWNLOADS}/hostd-v${version}`, {
            caddy: { bytes: files.caddy, version: "v2.11.6" },
            celld: { bytes: files.celld, compression: "gzip", version: "v0.6.0" },
            hostd: { bytes: files["lunora-hostd"], version },
        });

        return { envelope, files };
    };

    /** Source install.sh, replace what needs root or the network, and run `body`. */
    const installFunctions = (body: string, environment: Record<string, string> = {}): { code: number | null; output: string } => {
        const [keyId, pem] = Object.entries(key.trustedKeys)[0] as [string, string];
        const result = spawnSync(
            "/bin/bash",
            [
                "-c",
                [
                    "set -euo pipefail",
                    `source "${INSTALL_SCRIPT}"`,
                    String.raw`trusted_key() { if [ "$1" = "${keyId}" ]; then printf '%s\n' "$TEST_PEM"; else return 1; fi; }`,
                    `fetch() { cp -- "$TEST_RELEASES/\${1#${DOWNLOADS}/}" "$2"; }`,
                    'as_hostd() { "$@"; }',
                    `INSTALL_DIR="${join(box, "opt")}"`,
                    `CONFIG_DIR="${join(box, "etc")}"`,
                    `DATA_DIR="${join(box, "data")}"`,
                    `PLATFORM="${currentPlatform() ?? "linux-x64"}"`,
                    body,
                ].join("\n"),
            ],
            { encoding: "utf8", env: { PATH: "/usr/local/bin:/usr/bin:/bin", TEST_PEM: pem.trim(), TEST_RELEASES: join(root, "releases"), ...environment } },
        );

        return { code: result.status, output: `${result.stdout}${result.stderr}` };
    };

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-install-sh-"));
        key = createTestReleaseKey();
        await buildTestHostd({ bundlePath: join(root, "hostd.cjs"), launcherPath: join(root, "hostd"), trustedKeys: key.trustedKeys, version: "1.0.0" });
        launcher = readFileSync(join(root, "hostd"));
    });

    beforeEach(() => {
        box = mkdtempSync(join(root, "box-"));
        mkdirSync(join(box, "opt"));
        mkdirSync(join(box, "data"));
    });

    afterAll(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("verifies the manifest with OpenSSL, then has lunora-hostd install it beside nothing", async () => {
        expect.assertions(4);

        const { envelope, files } = release("1.0.0");

        publish("hostd-v1.0.0", envelope, files);

        const result = installFunctions("VERSION=1.0.0; install_release");

        expect(result.code, result.output).toBe(0);
        expect(readlinkSync(join(box, "opt", "current"))).toBe("hostd-v1_0_0");
        expect(spawnSync(join(box, "opt", "current", "celld"), { encoding: "utf8" }).stdout).toBe("celld 0.6.0\n");
        // The bootstrap directory beside the install directory is gone.
        expect(readdirSync(box).filter((name) => name.startsWith(".lunora-hostd-install"))).toStrictEqual([]);
    });

    it("refuses a manifest changed after signing before running anything from it", async () => {
        expect.assertions(3);

        const { envelope, files } = release("1.0.0");

        publish("hostd-v1.0.0", { ...envelope, manifest: { ...envelope.manifest, createdAt: "2026-10-04T12:00:00.000Z" } }, files);

        const result = installFunctions("VERSION=1.0.0; install_release");

        expect(result.code).toBe(1);
        expect(result.output).toMatch(/signature does not verify/u);
        expect(existsSync(join(box, "opt", "current"))).toBe(false);
    });

    it("refuses a lunora-hostd whose bytes the manifest does not pin", async () => {
        expect.assertions(3);

        const { envelope, files } = release("1.0.0");

        publish("hostd-v1.0.0", envelope, { ...files, "lunora-hostd": Buffer.concat([launcher, Buffer.from("# tampered\n")]) });

        const result = installFunctions("VERSION=1.0.0; install_release");

        expect(result.code).toBe(1);
        expect(result.output).toMatch(/lunora-hostd: the download is not the \d+ bytes the manifest pins/u);
        expect(existsSync(join(box, "opt", "current"))).toBe(false);
    });

    describe("without --version, the newest release on the box's channel", () => {
        const pointer = (latest: Record<string, unknown>): void => {
            mkdirSync(join(root, "releases", "hostd-latest"), { recursive: true });
            writeFileSync(join(root, "releases", "hostd-latest", "latest.json"), JSON.stringify({ schema: 1, ...latest }));
        };

        /** `resolve_tag` on the test box, with `flags` parsed first; prints the tag it chose. */
        const resolve = (flags = ""): { code: number | null; output: string } =>
            installFunctions(`parse_args ${flags}; WORK="$(mktemp -d)"; resolve_tag; printf 'TAG=%s\n' "$TAG"`);

        it("takes the newest stable release on a new box", () => {
            expect.assertions(1);

            pointer({ prerelease: "1.1.0-alpha.2", stable: "1.0.0" });

            expect(resolve().output).toMatch(/^TAG=hostd-v1\.0\.0$/mu);
        });

        it("takes the newest pre-release on a box that runs one, or when asked to", () => {
            expect.assertions(2);

            pointer({ prerelease: "1.1.0-alpha.2", stable: "1.0.0" });

            expect(resolve("--prerelease").output).toMatch(/^TAG=hostd-v1\.1\.0-alpha\.2$/mu);

            mkdirSync(join(box, "opt", "hostd-v1_1_0-alpha_1"), { recursive: true });
            writeFileSync(join(box, "opt", "hostd-v1_1_0-alpha_1", "manifest.json"), JSON.stringify({ manifest: { hostd: { version: "1.1.0-alpha.1" } } }));
            symlinkSync("hostd-v1_1_0-alpha_1", join(box, "opt", "current"));

            expect(resolve().output).toMatch(/^TAG=hostd-v1\.1\.0-alpha\.2$/mu);
        });

        it("says what to do while no stable release exists", () => {
            expect.assertions(2);

            pointer({ prerelease: "1.0.0-alpha.1", stable: null });

            const result = resolve();

            expect(result.code).toBe(1);
            expect(result.output).toMatch(/no stable hostd release is published yet; pass --version <version> or --prerelease/u);
        });

        it("installs exactly --version when given, without reading the pointer", () => {
            expect.assertions(1);

            expect(resolve("--version v2.0.0").output).toMatch(/^TAG=hostd-v2\.0\.0$/mu);
        });
    });

    describe("secrets", () => {
        const TOKEN = `lbe_${"7c".repeat(32)}`;

        /** `as_hostd` replaced by a probe: what enrol would run, and what its environment would hold. */
        const PROBE = String.raw`as_hostd() { printf 'ARGV=%s\n' "$*"; printf 'TOKEN=%s KEY=%s SECRET=%s\n' "$(printenv LUNORA_HOSTD_ENROL_TOKEN)" "$(printenv AWS_ACCESS_KEY_ID)" "$(printenv AWS_SECRET_ACCESS_KEY)"; }`;

        const ENROL = String.raw`${PROBE}; parse_args --control-plane https://cloud.example --bucket b; read_secrets; printf 'INHERITED=%s\n' "$(env | grep -c -e LUNORA_HOSTD_ENROL_TOKEN -e AWS_ || true)"; enrol`;

        it("hands the token and the bucket credentials to enrol through its environment alone, and to nothing else", () => {
            expect.assertions(4);

            const result = installFunctions(ENROL, { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "s3cr3t", LUNORA_HOSTD_ENROL_TOKEN: TOKEN });

            expect(result.code, result.output).toBe(0);
            expect(result.output).toContain(`TOKEN=${TOKEN} KEY=AKIATEST SECRET=s3cr3t`);
            // Not on enrol's command line, and not in the environment of anything else the script runs.
            expect(result.output).toMatch(/^ARGV=\S+\/lunora-hostd enrol --control-plane https:\/\/cloud\.example --bucket b$/mu);
            expect(result.output).toContain("INHERITED=0");
        });

        it("asks for the token and the bucket key at a terminal, echoing neither secret", async () => {
            expect.assertions(3);

            const scriptPath = join(box, "prompt.sh");

            writeFileSync(
                scriptPath,
                [
                    "set -euo pipefail",
                    `source "${INSTALL_SCRIPT}"`,
                    PROBE,
                    `CONFIG_DIR="${join(box, "etc")}"`,
                    `INSTALL_DIR="${join(box, "opt")}"`,
                    "parse_args --control-plane https://cloud.example --bucket b",
                    "read_secrets",
                    "enrol",
                ].join("\n"),
            );

            // `script` gives bash a terminal, so it asks; the answers go in as a person types them.
            const child = spawn("/usr/bin/script", ["-qec", `/bin/bash ${scriptPath}`, "/dev/null"], {
                env: { PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb" },
            });
            const output = answerPrompts(child, [
                [/Enrolment token \(the studio shows it; typing is not echoed\): $/u, `${TOKEN}\n`],
                [/Bucket access key id .*: $/u, "AKIATYPED\n"],
                [/Bucket secret access key \(typing is not echoed\): $/u, "typed-secret\n"],
            ]);
            const code = await new Promise<number | null>((resolve) => {
                child.once("exit", resolve);
            });

            expect(code, output.text).toBe(0);
            expect(output.text).toContain(`TOKEN=${TOKEN} KEY=AKIATYPED SECRET=typed-secret`);

            // What the terminal showed before the probe printed: the visible key id, never a secret.
            const shownAt = (typed: string): number => output.text.slice(0, output.text.indexOf("ARGV=")).indexOf(typed);

            expect(["AKIATYPED", TOKEN, "typed-secret"].map((typed) => shownAt(typed) !== -1)).toStrictEqual([true, false, false]);
        });

        it("refuses a token on the command line, and a token file anyone but root could have written", () => {
            expect.assertions(3);

            const tokenFile = join(box, "token");

            writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

            expect(installFunctions(`parse_args --token ${TOKEN}`).output).toMatch(/--token would leave the token in your shell history/u);

            const owned = installFunctions(`parse_args --token-file ${tokenFile}; read_secrets`);

            expect(owned.output).toMatch(/the token file \S+ must belong to root/u);
            expect(owned.output).not.toContain(TOKEN);
        });

        it("fails before downloading anything when there is no token and no terminal to ask at", () => {
            expect.assertions(2);

            const result = installFunctions("parse_args --bucket b; read_secrets");

            expect(result.code).toBe(1);
            expect(result.output).toMatch(/no enrolment token: run install\.sh in a terminal and paste it when asked, or pass --token-file/u);
        });
    });
});
