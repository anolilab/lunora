/**
 * A throwaway box for the daemon tests: a temp directory holding the config,
 * the key, the bucket credentials, the data directory and the fake binaries
 * (installed as release `hostd-v0_0_0` under `opt/`, with `current` pointing
 * at it, as install.sh lays a box out), enrolled with a {@link FakeControlPlane}.
 *
 * A test box is enrolled `--single-trust` and its daemon is given
 * {@link unisolatedSystem}: tests run unprivileged, so the isolation
 * self-check fails, and fleets run as the test's own user.
 */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostdConfig } from "../../../src/daemon/config";
import { parseHostdConfig, saveHostdConfig } from "../../../src/daemon/config";
import type { BoxIdentity } from "../../../src/daemon/identity";
import { generateIdentity } from "../../../src/daemon/identity";
import type { IsolationSystem } from "../../../src/daemon/isolation";
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

/** The release a test box starts on. */
const INITIAL_RELEASE = "hostd-v0_0_0";

/**
 * A system with nothing to isolate fleets with: no fleet user, no
 * capabilities, a login session's cgroup. Every check fails, without running
 * anything or touching the machine.
 */
const unisolatedSystem = (): IsolationSystem => {
    return {
        daemon: { gid: process.getgid?.() ?? 1000, uid: process.getuid?.() ?? 1000 },
        pid: process.pid,
        probe: async () => {
            throw new Error("tests do not start processes as another user");
        },
        readText: (path) => {
            if (path === "/proc/self/status") {
                return "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\n";
            }

            return path === "/proc/self/cgroup" ? "0::/user.slice/user-1000.slice/session-1.scope\n" : undefined;
        },
        setpriv: undefined,
        totalMemoryBytes: 2 * 1024 * 1024 * 1024,
    };
};

/** A box enrolled with `plane`, its bucket served by the plane's fake S3. */
const createTestBox = async (plane: FakeControlPlane, overrides: Record<string, unknown> = {}): Promise<TestBox> => {
    const root = mkdtempSync(join(tmpdir(), "lunora-hostd-test-"));
    const records = join(root, "records");
    const installDirectory = join(root, "opt");
    const release = join(installDirectory, INITIAL_RELEASE);

    writeFakeBinaries(release, records);
    writeFileSync(join(release, "lunora-hostd"), `#!${process.execPath}\nconsole.log("0.0.0");\n`);
    chmodSync(join(release, "lunora-hostd"), 0o755);
    // install.sh keeps each release's manifest beside its binaries.
    writeFileSync(join(release, "manifest.json"), "{}\n");
    symlinkSync(INITIAL_RELEASE, join(installDirectory, "current"));

    const identity = generateIdentity(join(root, "etc", "box.key"));
    const credentialsFile = join(root, "etc", "bucket.env");
    const first = await freePort();

    writeFileSync(credentialsFile, "AWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\n", { mode: 0o600 });
    plane.trust(identity.publicKey);

    const config = parseHostdConfig({
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
        keyFile: join(root, "etc", "box.key"),
        ports: { first, last: first + 19 },
        singleTrust: true,
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
export { createTestBox, freePort, INITIAL_RELEASE, unisolatedSystem };
