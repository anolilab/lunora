/**
 * Test releases of `lunora-hostd`, signed with a key the test generates.
 *
 * A real binary trusts only the release keys compiled into it, so a test that
 * runs one through `install.sh` or an `upgrade` needs a build that trusts the
 * test's key: {@link buildTestHostd} bundles `src/bin.ts` with esbuild exactly
 * as `scripts/build-sea.mjs` does, but with `trusted-release-keys.ts` and
 * `version.ts` replaced. That replacement exists only here, in the tests — no
 * shipped build has a way to take a key from anywhere but its source.
 */
import type { KeyObject } from "node:crypto";
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import type { HostdReleaseArtifact, HostdReleaseEnvelope, HostdReleaseManifest, HostdReleasePlatform } from "../../src/release";
import { releaseKeyId, signReleaseManifest } from "../../src/release-verify";

const SOURCE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** A release-signing key pair, and the trusted-key set that pins its public half. */
interface TestReleaseKey {
    privateKey: KeyObject;
    trustedKeys: Record<string, string>;
}

const createTestReleaseKey = (): TestReleaseKey => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    return { privateKey, trustedKeys: { [releaseKeyId(publicKey)]: publicKey.export({ format: "pem", type: "spki" }) } };
};

/**
 * Bundle `lunora-hostd` into `bundlePath` (CommonJS, as the single executable
 * runs it) reporting `version` and trusting exactly `trustedKeys`, and write an
 * executable `launcherPath` that runs it on this machine's node.
 */
const buildTestHostd = async (input: {
    bundlePath: string;
    launcherPath: string;
    nodePath?: string;
    trustedKeys: Record<string, string>;
    version: string;
}): Promise<void> => {
    await build({
        bundle: true,
        entryPoints: [join(SOURCE_DIRECTORY, "bin.ts")],
        format: "cjs",
        legalComments: "none",
        logLevel: "warning",
        outfile: input.bundlePath,
        platform: "node",
        plugins: [
            {
                name: "test-release-keys",
                setup: (plugin) => {
                    // esbuild matches filters with Go's regexp, which has no `u` flag.

                    plugin.onLoad({ filter: /[/\\]src[/\\]trusted-release-keys\.ts$/ }, () => {
                        return {
                            contents: `export const HOSTD_RELEASE_KEY_PLACEHOLDER = "PLACEHOLDER-NOT-A-KEY";\nexport const HOSTD_TRUSTED_RELEASE_KEYS = Object.freeze(${JSON.stringify(input.trustedKeys)});\n`,
                            loader: "ts",
                        };
                    });

                    plugin.onLoad({ filter: /[/\\]src[/\\]version\.ts$/ }, () => {
                        return { contents: `export default ${JSON.stringify(input.version)};\n`, loader: "ts" };
                    });
                },
            },
        ],
        target: `node${process.versions.node}`,
    });
    writeFileSync(input.launcherPath, `#!/bin/sh\nexec "${input.nodePath ?? process.execPath}" "${input.bundlePath}" "$@"\n`, { mode: 0o755 });
};

/** The manifest entry pinning `bytes` at `url` for both platforms. */
const pinArtifact = (url: string, bytes: Uint8Array, compression?: "gzip"): HostdReleaseArtifact[] => {
    const pinned = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        url,
        ...(compression === undefined ? {} : { compression }),
    };

    return (["linux-arm64", "linux-x64"] as HostdReleasePlatform[]).map((platform) => {
        return { platform, ...pinned };
    });
};

/** A release's three published files, by component. */
interface TestReleaseFiles {
    caddy: { bytes: Uint8Array; compression?: "gzip"; version: string };
    celld: { bytes: Uint8Array; compression?: "gzip"; version: string };
    hostd: { bytes: Uint8Array; compression?: "gzip"; version: string };
}

/** Sign a manifest pinning `files` under `baseUrl/{lunora-hostd,celld,caddy}`. */
const signTestRelease = (key: TestReleaseKey, releaseId: string, baseUrl: string, files: TestReleaseFiles): HostdReleaseEnvelope => {
    const manifest: HostdReleaseManifest = {
        caddy: {
            artifacts: pinArtifact(`${baseUrl}/caddy`, files.caddy.bytes, files.caddy.compression),
            modules: ["github.com/mholt/caddy-ratelimit"],
            version: files.caddy.version,
        },
        celld: { artifacts: pinArtifact(`${baseUrl}/celld`, files.celld.bytes, files.celld.compression), version: files.celld.version },
        createdAt: "2026-10-03T12:00:00.000Z",
        hostd: { artifacts: pinArtifact(`${baseUrl}/lunora-hostd`, files.hostd.bytes, files.hostd.compression), version: files.hostd.version },
        releaseId,
        schema: 1,
    };

    return signReleaseManifest(manifest, key.privateKey);
};

export type { TestReleaseFiles, TestReleaseKey };
export { buildTestHostd, createTestReleaseKey, pinArtifact, signTestRelease };
