/**
 * A throwaway box for the black-box daemon tests: a temp directory holding
 * the config, the key, the bucket credentials, the data directory and the fake
 * binaries (installed as release `hostd-v0_0_0` under `opt/`, with `current`
 * pointing at it, as install.sh lays a box out), enrolled with a
 * {@link FakeControlPlane}. The Rust daemon reads all of it as it would on a
 * box: the config in the JSON `lunora-hostd enrol` writes, the key as PKCS#8 PEM.
 *
 * A test box is enrolled `--single-trust`: tests run unprivileged, with no
 * `lunora-fleet` user, so the isolation self-check fails and fleets run as the
 * test's own user.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFakeBinaries } from "./fake-binaries";
import type { FakeControlPlane } from "./fake-control-plane";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX_LENGTH = 12;

/** The configuration a test box runs with, as `config.json` holds it. */
interface TestBoxConfig {
    boxId: string;
    bucket: { endpoint?: string; name: string; region?: string };
    caddy: { adminAddress: string; askAddress: string; httpPort: number; httpsPort: number; tls: boolean };
    controlPlane: string;
    credentialsFile: string;
    dataDir: string;
    hostname: string;
    installDir: string;
    keyFile: string;
    ports: { first: number; last: number };
    singleTrust: boolean;
}

interface TestBox {
    cleanup: () => void;
    config: TestBoxConfig;
    configPath: string;
    /** The box's raw public key, base64url, as the control plane registers it. */
    identity: { publicKey: string };
    /** Where the fake binaries record their runs. */
    records: string;
    root: string;
    /** Rewrite `config.json` (a test that runs the daemon again with another setting). */
    write: (config: TestBoxConfig) => void;
}

/** A free loopback port. */
const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            server.close(() => {
                resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
        });
    });

/** The release a test box starts on. */
const INITIAL_RELEASE = "hostd-v0_0_0";

/** A box enrolled with `plane`, its bucket served by the plane's fake S3. */
const createTestBox = async (plane: FakeControlPlane, overrides: Partial<TestBoxConfig> = {}): Promise<TestBox> => {
    const root = mkdtempSync(join(tmpdir(), "lunora-hostd-test-"));
    const records = join(root, "records");
    const installDirectory = join(root, "opt");
    const release = join(installDirectory, INITIAL_RELEASE);
    const etc = join(root, "etc");

    writeFakeBinaries(release, records);
    writeFileSync(join(release, "lunora-hostd"), `#!${process.execPath}\nconsole.log("0.0.0");\n`);
    chmodSync(join(release, "lunora-hostd"), 0o755);
    // install.sh keeps each release's manifest beside its binaries.
    writeFileSync(join(release, "manifest.json"), "{}\n");
    symlinkSync(INITIAL_RELEASE, join(installDirectory, "current"));
    mkdirSync(etc, { mode: 0o700, recursive: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyFile = join(etc, "box.key");
    const identity = { publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX_LENGTH).toString("base64url") };
    const credentialsFile = join(etc, "bucket.env");
    const first = await freePort();

    writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    writeFileSync(credentialsFile, "AWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\n", { mode: 0o600 });
    plane.trust(identity.publicKey);

    const config: TestBoxConfig = {
        boxId: plane.boxId,
        bucket: { endpoint: `${plane.origin}/s3`, name: "customer-bucket", region: "us-east-1" },
        caddy: {
            adminAddress: `127.0.0.1:${String(await freePort())}`,
            askAddress: `127.0.0.1:${String(await freePort())}`,
            httpPort: 8080,
            httpsPort: 8443,
            tls: false,
        },
        controlPlane: plane.origin,
        credentialsFile,
        dataDir: join(root, "data"),
        hostname: plane.hostname,
        installDir: installDirectory,
        keyFile,
        ports: { first, last: first + 19 },
        singleTrust: true,
        ...overrides,
    };
    const configPath = join(etc, "config.json");
    const write = (next: TestBoxConfig): void => {
        writeFileSync(configPath, `${JSON.stringify(next, undefined, 4)}\n`, { mode: 0o640 });
    };

    write(config);

    return {
        cleanup: () => {
            rmSync(root, { force: true, recursive: true });
        },
        config,
        configPath,
        identity,
        records,
        root,
        write,
    };
};

export type { TestBox, TestBoxConfig };
export { createTestBox, freePort, INITIAL_RELEASE };
