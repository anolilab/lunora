import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { binaryPaths, configPathOf, loadBucketCredentials, parseHostdConfig } from "../../src/daemon/config";
import { loadIdentity } from "../../src/daemon/identity";
import { fleetSummaries, loadState, saveState } from "../../src/daemon/state";

const minimal = {
    boxId: "box_1",
    bucket: { name: "b" },
    controlPlane: "https://cloud.example",
    credentialsFile: "/etc/lunora-hostd/bucket.env",
    hostname: "bx.boxes.lunora.app",
    keyFile: "/etc/lunora-hostd/box.key",
};

describe(parseHostdConfig, () => {
    it("fills the defaults a hand-written config leaves out", () => {
        expect.assertions(1);

        expect(parseHostdConfig(minimal)).toStrictEqual({
            ...minimal,
            allowRoot: false,
            caddy: { adminAddress: "127.0.0.1:2019", askAddress: "127.0.0.1:2020", httpPort: 80, httpsPort: 443, tls: true },
            dataDir: "/var/lib/lunora-hostd",
            fleetUser: "lunora-fleet",
            installDir: "/opt/lunora-hostd",
            ports: { first: 20_000, last: 20_999 },
            singleTrust: false,
        });
    });

    it.each([
        [{ controlPlane: "https://cloud.example/v1" }, /controlPlane/u],
        [{ boxId: "box:1" }, /boxId/u],
        [{ caddy: { adminAddress: "0.0.0.0:2019" } }, /adminAddress/u],
        [{ ports: { first: 21_000, last: 20_000 } }, /ports.last/u],
        [{ keyFile: "relative/box.key" }, /keyFile/u],
        [{ fleetUser: "root; rm -rf /" }, /fleetUser/u],
        [{ fleetMemoryMaxMb: 16 }, /fleetMemoryMaxMb/u],
        [{ installDir: "opt/lunora-hostd" }, /installDir/u],
    ])("refuses %o", (override, message) => {
        expect.assertions(1);

        expect(() => parseHostdConfig({ ...minimal, ...override })).toThrow(message);
    });

    it("runs the binaries of the current release in the install directory", () => {
        expect.assertions(1);

        expect(binaryPaths(parseHostdConfig({ ...minimal, installDir: "/srv/hostd" }))).toStrictEqual({
            caddy: "/srv/hostd/current/caddy",
            celld: "/srv/hostd/current/celld",
            hostd: "/srv/hostd/current/lunora-hostd",
        });
    });

    it("resolves --config, then LUNORA_HOSTD_CONFIG, then the default", () => {
        expect.assertions(3);

        expect(configPathOf("/a.json", { LUNORA_HOSTD_CONFIG: "/b.json" })).toBe("/a.json");
        expect(configPathOf(undefined, { LUNORA_HOSTD_CONFIG: "/b.json" })).toBe("/b.json");
        expect(configPathOf(undefined, {})).toBe("/etc/lunora-hostd/config.json");
    });
});

describe("secret files", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-hostd-config-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("reads only the AWS credential names, and refuses a credentials file others can read", () => {
        expect.assertions(2);

        const path = join(directory, "bucket.env");

        writeFileSync(path, "AWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=b\nLD_PRELOAD=/evil.so\n", { mode: 0o600 });

        expect(loadBucketCredentials(path)).toStrictEqual({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" });

        chmodSync(path, 0o644);

        expect(() => loadBucketCredentials(path)).toThrow(/readable by others/u);
    });

    it("refuses a box key others can read", () => {
        expect.assertions(1);

        const path = join(directory, "box.key");

        writeFileSync(path, "x", { mode: 0o644 });

        expect(() => loadIdentity(path)).toThrow(/readable by others/u);
    });
});

describe("local state", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-hostd-state-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("round-trips, drops malformed entries, and reports hello.fleets sorted", () => {
        expect.assertions(2);

        saveState(directory, {
            fleets: {
                "b-app": { internalPort: 20_003, publicPort: 20_002, state: "stopped", updatedAt: 1 },
                "a-app": { deploymentId: "dep_1", internalPort: 20_001, publicPort: 20_000, state: "running", updatedAt: 1 },
            },
            version: 1,
        });
        writeFileSync(join(directory, "state.json.bak"), "");

        const state = loadState(directory);

        expect(fleetSummaries(state, 500)).toStrictEqual([
            { alias: "a-app", deploymentId: "dep_1", state: "running" },
            { alias: "b-app", state: "stopped" },
        ]);

        writeFileSync(
            join(directory, "state.json"),
            JSON.stringify({ fleets: { "Bad Alias": { internalPort: 1, publicPort: 2, state: "running", updatedAt: 1 }, ok: { state: "nope" } } }),
        );

        expect(loadState(directory).fleets).toStrictEqual({});
    });
});
