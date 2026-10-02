/**
 * A throwaway box for the daemon tests: a temp directory holding the config,
 * the key, the bucket credentials, the data directory and the fake binaries,
 * enrolled with a {@link FakeControlPlane}.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostdConfig } from "../../../src/daemon/config";
import { parseHostdConfig, saveHostdConfig } from "../../../src/daemon/config";
import type { BoxIdentity } from "../../../src/daemon/identity";
import { generateIdentity } from "../../../src/daemon/identity";
import { writeFakeBinaries } from "./fake-binaries";
import type { FakeControlPlane } from "./fake-control-plane";

interface TestBox {
    cleanup: () => void;
    config: HostdConfig;
    configPath: string;
    identity: BoxIdentity;
    /** Where the fake binaries record their runs. */
    records: string;
    root: string;
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

/** A box enrolled with `plane`, its bucket served by the plane's fake S3. */
const createTestBox = async (plane: FakeControlPlane, overrides: Record<string, unknown> = {}): Promise<TestBox> => {
    const root = mkdtempSync(join(tmpdir(), "lunora-hostd-test-"));
    const records = join(root, "records");
    const binaries = writeFakeBinaries(join(root, "bin"), records);
    const identity = generateIdentity(join(root, "etc", "box.key"));
    const credentialsFile = join(root, "etc", "bucket.env");
    const first = await freePort();

    writeFileSync(credentialsFile, "AWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\n", { mode: 0o600 });
    plane.trust(identity.publicKey);

    const config = parseHostdConfig({
        binaries,
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
        keyFile: join(root, "etc", "box.key"),
        ports: { first, last: first + 19 },
        ...overrides,
    });
    const configPath = join(root, "etc", "config.json");

    saveHostdConfig(configPath, config);

    return {
        cleanup: () => {
            rmSync(root, { force: true, recursive: true });
        },
        config,
        configPath,
        identity,
        records,
        root,
    };
};

export type { TestBox };
export { createTestBox, freePort };
