/**
 * Test releases of `lunora-hostd`, signed with the tests' own release key.
 *
 * A real binary trusts only the release keys compiled into it, so a test that
 * runs one through `install.sh` or an `upgrade` needs a build that trusts the
 * test key: `buildHostd({ trustedKeys })` from `hostd-binary.ts`. The key is
 * fixed rather than generated per run, so that build keeps its target
 * directory from run to run and cargo rebuilds it incrementally. No shipped
 * build trusts it.
 */
import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import type { HostdReleaseArtifact, HostdReleaseEnvelope, HostdReleaseManifest, HostdReleasePlatform } from "../../src/release";
import { releaseKeyId, signReleaseManifest } from "../../src/release-verify";

/** A release-signing key pair, and the trusted-key set that pins its public half. */
interface TestReleaseKey {
    privateKey: KeyObject;
    trustedKeys: Record<string, string>;
}

/** The test key as Ed25519 PKCS#8: the fixed DER prefix, then a constant 32-byte seed. */
const TEST_KEY_PKCS8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x4c)]);

const createTestReleaseKey = (): TestReleaseKey => {
    const privateKey = createPrivateKey({ format: "der", key: TEST_KEY_PKCS8, type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);

    return { privateKey, trustedKeys: { [releaseKeyId(publicKey)]: publicKey.export({ format: "pem", type: "spki" }) } };
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
export { createTestReleaseKey, pinArtifact, signTestRelease };
