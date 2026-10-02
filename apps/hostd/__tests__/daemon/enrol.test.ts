/**
 * `lunora-hostd enrol` through the binary's own entry point, against the fake
 * control plane: what it sends, what it writes, and that the token never
 * appears in anything it prints.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHostdConfig, permissionsOf } from "../../src/daemon/config";
import { publicAddresses } from "../../src/daemon/enrol";
import { runBin } from "../../src/run-bin";
import { writeFakeBinaries } from "./helpers/fake-binaries";
import { FakeControlPlane } from "./helpers/fake-control-plane";

const TOKEN = `lbe_${"a1".repeat(32)}`;

describe("lunora-hostd enrol", () => {
    let plane: FakeControlPlane;
    let root: string;
    let output: { stderr: string; stdout: string };

    const run = async (argv: string[], environment: NodeJS.ProcessEnv = {}): Promise<number> =>
        runBin(
            argv,
            {
                stderr: (text) => {
                    output.stderr += text;
                },
                stdout: (text) => {
                    output.stdout += text;
                },
            },
            { environment: { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "s3cr3t", ...environment } },
        );

    const enrolArgs = (...extra: string[]): string[] => [
        "enrol",
        "--config",
        join(root, "etc", "config.json"),
        "--data-dir",
        join(root, "data"),
        "--control-plane",
        plane.origin,
        "--bucket",
        "s3://customer-bucket",
        "--endpoint",
        "https://s3.example.com",
        "--ipv4",
        "203.0.113.7",
        ...extra,
    ];

    beforeEach(async () => {
        plane = new FakeControlPlane();
        await plane.listen();
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-enrol-"));
        mkdirSync(join(root, "data"), { recursive: true });
        // celld's bucket probe runs the installed celld: here, the fake.
        writeFakeBinaries(join(root, "data", "bin"), join(root, "records"));
        output = { stderr: "", stdout: "" };
    });

    afterEach(async () => {
        await plane.close();
        rmSync(root, { force: true, recursive: true });
    });

    it("enrols, writes the config, the key and the credentials, and never prints the token", async () => {
        expect.assertions(10);

        await expect(run(enrolArgs("--token", TOKEN))).resolves.toBe(0);

        const [request] = plane.enrolments;

        expect(request).toMatchObject({ ipv4: "203.0.113.7", singleTrust: false, token: TOKEN, versions: { caddy: "v2.11.6", celld: "0.6.0" } });
        expect(request?.["publicKey"]).toMatch(/^[\w-]{43}$/u);

        const config = loadHostdConfig(join(root, "etc", "config.json"));

        expect(config).toMatchObject({
            boxId: plane.boxId,
            bucket: { endpoint: "https://s3.example.com", name: "customer-bucket" },
            controlPlane: plane.origin,
            hostname: plane.hostname,
        });
        expect(permissionsOf(statSync(config.keyFile).mode)).toBe(0o600);
        expect(permissionsOf(statSync(config.credentialsFile).mode)).toBe(0o600);
        expect(readFileSync(config.credentialsFile, "utf8")).toContain("AWS_SECRET_ACCESS_KEY=s3cr3t");
        // Nothing secret in the config, nor in anything printed.
        expect(readFileSync(join(root, "etc", "config.json"), "utf8")).not.toMatch(/s3cr3t|lbe_/u);
        expect(`${output.stdout}${output.stderr}`).not.toContain(TOKEN);
        expect(`${output.stdout}${output.stderr}`).not.toContain("s3cr3t");
    });

    it("takes the token from the environment", async () => {
        expect.assertions(2);

        await expect(run(enrolArgs(), { LUNORA_HOSTD_ENROL_TOKEN: TOKEN })).resolves.toBe(0);
        expect(plane.enrolments[0]?.["token"]).toBe(TOKEN);
    });

    it("reports a refused token without echoing it", async () => {
        expect.assertions(3);

        const bad = `lbe_${"zz".repeat(32)}`;

        await expect(run(enrolArgs("--token", bad))).resolves.toBe(1);
        expect(output.stderr).toMatch(/refused the enrolment \(403\): invalid or expired enrolment token/u);
        expect(output.stderr).not.toContain(bad);
    });

    it("refuses to enrol an enrolled machine again without --force", async () => {
        expect.assertions(3);

        await run(enrolArgs("--token", TOKEN));

        await expect(run(enrolArgs("--token", TOKEN))).resolves.toBe(1);
        expect(output.stderr).toMatch(/enrolled already/u);
        expect(plane.enrolments).toHaveLength(1);
    });

    it("needs a control plane while no production default is published", async () => {
        expect.assertions(3);

        await expect(run(["enrol", "--config", join(root, "etc", "config.json"), "--bucket", "b", "--token", TOKEN])).resolves.toBe(1);
        expect(output.stderr).toMatch(/pass --control-plane/u);
        expect(existsSync(join(root, "etc", "config.json"))).toBe(false);
    });

    it("does not echo an unexpected argument, which might be the token", async () => {
        expect.assertions(2);

        await expect(run(["enrol", TOKEN])).resolves.toBe(1);
        expect(output.stderr).not.toContain(TOKEN);
    });
});

describe(publicAddresses, () => {
    it("picks the first public IPv4 and global IPv6, never a private or loopback one", () => {
        expect.assertions(1);

        const entry = (address: string, family: "IPv4" | "IPv6", internal = false) => {
            return { address, cidr: null, family, internal, mac: "00:00:00:00:00:00", netmask: "" };
        };

        expect(
            publicAddresses({
                // eslint-disable-next-line sonarjs/no-hardcoded-ip -- private and link-local fixtures the detection must skip
                eth0: [entry("10.0.0.4", "IPv4"), entry("fe80::1", "IPv6"), entry("198.51.100.20", "IPv4"), entry("2001:db8::20", "IPv6")],
                lo: [entry("127.0.0.1", "IPv4", true)],
            } as never),
        ).toStrictEqual({ ipv4: "198.51.100.20", ipv6: "2001:db8::20" });
    });
});
