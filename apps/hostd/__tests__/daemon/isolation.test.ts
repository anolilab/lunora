/**
 * Fleet isolation (plan 458 W8), without root: the generated nftables
 * ruleset, the environment allowlist, the cgroup path logic (against a cgroup
 * tree in a temp directory), the capability plumbing, and the self-check's
 * decision table — with the system it reads and runs injected. Applying the
 * table, switching uids and moving processes between cgroups for real is the
 * `test:hostd` lane's job (`__tests__/integration/`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BlockList } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lookupAccount } from "../../src/daemon/accounts";
import { dropCapabilitiesPrefix, hasCapability, launchCommand, launchIdentity, parseProcessStatus } from "../../src/daemon/capabilities";
import { CgroupManager, cgroupPathOf, delegatedServiceOf, fleetMemoryMax } from "../../src/daemon/cgroups";
import { parseHostdConfig, permissionsOf } from "../../src/daemon/config";
import { allowlisted, FLEET_ENVIRONMENT_ALLOWLIST, fleetEnvironment } from "../../src/daemon/fleet-environment";
import type { IsolationChecks, IsolationSystem } from "../../src/daemon/isolation";
import { decideIsolation, ensureFleetDirectory, helloIsolation, setUpIsolation, shareWithFleet } from "../../src/daemon/isolation";
import { silentLogger } from "../../src/daemon/log";
import type { FirewallSystem } from "../../src/daemon/nftables";
import { BLOCKED_IPV4, BLOCKED_IPV6, bucketEndpointOf, EgressFirewall, nftBucketUpdate, nftRuleset } from "../../src/daemon/nftables";

const MIB = 1024 * 1024;

/** `/proc/self/status` lines for a process with `uid` and these capability sets. */
const status = (uid: number, effective: string, ambient: string, noNewPrivs = 0): string =>
    [
        `Uid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}`,
        `CapEff:\t${effective}`,
        `CapAmb:\t${ambient}`,
        `NoNewPrivs:\t${String(noNewPrivs)}`,
    ].join("\n");

/** The ambient set the systemd unit grants: chown, kill, setgid, setuid, net_bind_service, net_admin. */
const UNIT_CAPABILITIES = "00000000000014e1";

/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols -- the egress policy is made of addresses: these are what it blocks or lets through */
describe("the nftables ruleset", () => {
    it("filters only the fleet uid: replies, DNS and the bucket pass, private and loopback ranges are rejected", () => {
        expect.assertions(1);

        expect(nftRuleset(990, { ipv4: ["127.0.0.1", "203.0.113.9"], ipv6: ["2001:db8::9"], port: 19_000 })).toBe(
            [
                "table inet lunora_hostd",
                "delete table inet lunora_hostd",
                "table inet lunora_hostd {",
                "    set bucket_v4 {",
                "        type ipv4_addr . inet_service",
                "        elements = { 127.0.0.1 . 19000, 203.0.113.9 . 19000 }",
                "    }",
                "    set bucket_v6 {",
                "        type ipv6_addr . inet_service",
                "        elements = { 2001:db8::9 . 19000 }",
                "    }",
                "    chain fleet_egress {",
                "        type filter hook output priority 0; policy accept;",
                "        meta skuid != 990 return",
                "        ct state established,related accept",
                "        udp dport 53 accept",
                "        tcp dport 53 accept",
                "        ip daddr . tcp dport @bucket_v4 accept",
                "        ip6 daddr . tcp dport @bucket_v6 accept",
                "        ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject",
                "        ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10 } reject",
                "    }",
                "}",
                "",
            ].join("\n"),
        );
    });

    it("blocks loopback, RFC 1918, link-local with the metadata service, CGNAT, ULA and IPv6 link-local", () => {
        expect.assertions(2);

        // One list per family: Node's BlockList matches an IPv4 address against a v4-mapped IPv6 range too.
        const listOf = (ranges: ReadonlyArray<string>, family: "ipv4" | "ipv6"): BlockList => {
            const list = new BlockList();

            for (const range of ranges) {
                const [network = "", prefix = ""] = range.split("/");

                list.addSubnet(network, Number(prefix), family);
            }

            return list;
        };
        const v4 = ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "8.8.8.8", "203.0.113.9"];
        const v6 = ["::1", "fd00::1", "fe80::1", "2001:db8::1"];

        expect(v4.map((address) => listOf(BLOCKED_IPV4, "ipv4").check(address, "ipv4"))).toStrictEqual([
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            false,
            false,
        ]);
        expect(v6.map((address) => listOf(BLOCKED_IPV6, "ipv6").check(address, "ipv6"))).toStrictEqual([true, true, true, false]);
    });

    it("leaves an empty bucket set without elements, and never writes anything but an address into the script", () => {
        expect.assertions(3);

        const script = nftRuleset(990, { ipv4: ["1.2.3.4 . 1 }; flush ruleset; add table x {", "not-an-address"], ipv6: ["::1; flush ruleset"], port: 443 });

        expect(script).not.toContain("flush ruleset");
        expect(script).not.toContain("elements");
        expect(nftBucketUpdate({ ipv4: ["198.51.100.1", "evil;"], ipv6: [], port: 443 })).toBe(
            [
                "flush set inet lunora_hostd bucket_v4",
                "flush set inet lunora_hostd bucket_v6",
                "add element inet lunora_hostd bucket_v4 { 198.51.100.1 . 443 }",
                "",
            ].join("\n"),
        );
    });

    it.each([
        [{ name: "b" }, { host: "s3.us-east-1.amazonaws.com", port: 443 }],
        [
            { name: "b", region: "eu-west-1" },
            { host: "s3.eu-west-1.amazonaws.com", port: 443 },
        ],
        [
            { endpoint: "http://127.0.0.1:19000", name: "b" },
            { host: "127.0.0.1", port: 19_000 },
        ],
        [
            { endpoint: "https://acc.r2.cloudflarestorage.com", name: "b" },
            { host: "acc.r2.cloudflarestorage.com", port: 443 },
        ],
        [
            { endpoint: "http://[fd00::5]:9000", name: "b" },
            { host: "fd00::5", port: 9000 },
        ],
    ])("takes the bucket endpoint of %o", (bucket, endpoint) => {
        expect.assertions(1);

        expect(bucketEndpointOf(bucket)).toStrictEqual(endpoint);
    });
});

/* eslint-enable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols */

describe(EgressFirewall, () => {
    const fakeFirewall = (addresses: { ipv4: string[]; ipv6: string[] }, present = true): FirewallSystem & { applied: string[] } => {
        const applied: string[] = [];

        return {
            applied,
            apply: async (script) => {
                applied.push(script);
            },
            present: async () => present,
            resolve: async () => addresses,
        };
    };

    it("installs the table, then swaps the bucket set only when the addresses change", async () => {
        expect.assertions(4);

        const addresses = { ipv4: ["192.0.2.2", "192.0.2.1"], ipv6: [] };
        const system = fakeFirewall(addresses);
        const firewall = new EgressFirewall({ bucket: { endpoint: "https://store.example:9000", name: "b" }, fleetUid: 990, logger: silentLogger, system });

        await firewall.install();
        await firewall.refresh();

        expect(system.applied).toHaveLength(1);
        expect(system.applied[0]).toContain("elements = { 192.0.2.1 . 9000, 192.0.2.2 . 9000 }");

        addresses.ipv4 = ["192.0.2.3"];
        await firewall.refresh();
        firewall.stop();

        expect(system.applied).toHaveLength(2);
        expect(system.applied[1]).toContain("add element inet lunora_hostd bucket_v4 { 192.0.2.3 . 9000 }");
    });

    it("fails when the table is not loaded afterwards", async () => {
        expect.assertions(1);

        const firewall = new EgressFirewall({
            bucket: { name: "b" },
            fleetUid: 990,
            logger: silentLogger,
            system: fakeFirewall({ ipv4: [], ipv6: [] }, false),
        });

        await expect(firewall.install()).rejects.toThrow(/not loaded/u);
    });
});

describe("the fleet environment", () => {
    it("is built from nothing: credentials, region, durability, a PATH, LANG and the fleet's own directory", () => {
        expect.assertions(2);

        const credentials = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" };

        expect(fleetEnvironment({ credentials, directory: "/var/lib/lunora-hostd/fleets/app", kind: "node", region: "auto" })).toStrictEqual({
            AWS_ACCESS_KEY_ID: "id",
            AWS_REGION: "auto",
            AWS_SECRET_ACCESS_KEY: "secret",
            CELLD_DURABILITY: "bucket",
            HOME: "/var/lib/lunora-hostd/fleets/app",
            LANG: "C.UTF-8",
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            RUST_LOG: "error,celld=warn",
            TMPDIR: "/var/lib/lunora-hostd/fleets/app",
        });
        expect(fleetEnvironment({ credentials: {}, directory: "/d", kind: "command" })).not.toHaveProperty("CELLD_DURABILITY");
    });

    it("drops every name off the allowlist, whatever a caller hands it", () => {
        expect.assertions(2);

        const smuggled = {
            AWS_ACCESS_KEY_ID: "id",
            LD_PRELOAD: "/opt/evil/x.so",
            LUNORA_HOSTD_CONFIG: "/etc/lunora-hostd/config.json",
            LUNORA_HOSTD_ENROL_TOKEN: "lbe_secret",
            NOTIFY_SOCKET: "/run/systemd/notify",
        };

        expect(fleetEnvironment({ credentials: smuggled, directory: "/d", kind: "node" })).not.toMatchObject({ LUNORA_HOSTD_CONFIG: expect.anything() });
        expect(Object.keys(allowlisted(smuggled))).toStrictEqual(["AWS_ACCESS_KEY_ID"]);
    });

    it("names nothing of hostd's own on the allowlist", () => {
        expect.assertions(1);

        expect([...FLEET_ENVIRONMENT_ALLOWLIST].filter((name) => /HOSTD|LUNORA|CONTROL|KEY_FILE|NOTIFY|CREDENTIALS_DIRECTORY/u.test(name))).toStrictEqual([]);
    });
});

describe("accounts and capabilities", () => {
    it("finds a local account in /etc/passwd", () => {
        expect.assertions(2);

        const passwd = "root:x:0:0:root:/root:/bin/bash\nlunora-fleet:x:996:993::/nonexistent:/usr/sbin/nologin\n";

        expect(lookupAccount("lunora-fleet", passwd)).toStrictEqual({ gid: 993, uid: 996, user: "lunora-fleet" });
        expect(lookupAccount("lunora", passwd)).toBeUndefined();
    });

    it("reads uid, capability sets and no_new_privs from /proc/self/status", () => {
        expect.assertions(4);

        const parsed = parseProcessStatus(status(997, UNIT_CAPABILITIES, UNIT_CAPABILITIES, 1));

        expect(parsed).toStrictEqual({ ambient: 0x14_e1n, effective: 0x14_e1n, noNewPrivs: true, uid: 997 });
        expect((["chown", "kill", "net_admin", "net_bind_service", "setgid", "setuid"] as const).every((name) => hasCapability(0x14_e1n, name))).toBe(true);
        expect(hasCapability(0x14_e1n, "net_admin") && !hasCapability(0x4_e1n, "net_admin")).toBe(true);
        expect(parseProcessStatus("Name:\tcat\n")).toBeUndefined();
    });

    it("starts a child through setpriv, dropping every inherited capability but the ones it keeps", () => {
        expect.assertions(3);

        const launch = { gid: 993, prefix: dropCapabilitiesPrefix("/usr/bin/setpriv"), uid: 996 };

        expect(launchCommand(launch, "/opt/lunora-hostd/current/celld", ["--listen", "127.0.0.1:20000"])).toStrictEqual({
            args: ["--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", "/opt/lunora-hostd/current/celld", "--listen", "127.0.0.1:20000"],
            command: "/usr/bin/setpriv",
        });
        expect(dropCapabilitiesPrefix("/usr/bin/setpriv", ["net_bind_service"]).slice(1, 3)).toStrictEqual([
            "--inh-caps=-all,+net_bind_service",
            "--ambient-caps=-all,+net_bind_service",
        ]);
        expect([launchIdentity(launch), launchCommand({ prefix: [] }, "caddy", ["run"])]).toStrictEqual([
            { gid: 993, uid: 996 },
            { args: ["run"], command: "caddy" },
        ]);
    });
});

describe("cgroups", () => {
    let root: string;
    const service = "/system.slice/lunora-hostd.service";

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-cgroup-"));
        mkdirSync(join(root, service), { recursive: true });
        writeFileSync(join(root, service, "cgroup.controllers"), "cpuset cpu io memory pids\n");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it.each([
        ["0::/system.slice/lunora-hostd.service\n", "/system.slice/lunora-hostd.service", "/system.slice/lunora-hostd.service"],
        ["0::/system.slice/lunora-hostd.service/hostd\n", "/system.slice/lunora-hostd.service/hostd", "/system.slice/lunora-hostd.service"],
        ["0::/user.slice/user-1000.slice/user@1000.service\n", "/user.slice/user-1000.slice/user@1000.service", undefined],
        ["0::/user.slice/user-1000.slice/session-2.scope\n", "/user.slice/user-1000.slice/session-2.scope", undefined],
        ["12:memory:/system.slice\n", undefined, undefined],
    ])("finds the delegated service cgroup in %j", (procSelfCgroup, path, delegated) => {
        expect.assertions(2);

        expect(cgroupPathOf(procSelfCgroup)).toBe(path);
        expect(path === undefined ? undefined : delegatedServiceOf(path)).toBe(delegated);
    });

    it("moves the daemon into hostd/, enables memory for the children, and gives each fleet its own limit", () => {
        expect.assertions(6);

        const cgroups = CgroupManager.setUp({ memoryMax: 512 * MIB, pid: 4242, procSelfCgroup: `0::${service}\n`, root });
        const base = join(root, service);

        expect(readFileSync(join(base, "hostd", "cgroup.procs"), "utf8")).toBe("4242");
        expect(readFileSync(join(base, "cgroup.subtree_control"), "utf8")).toBe("+memory");

        cgroups.attach("my-app", 5151);

        expect(readFileSync(join(base, "fleet-my-app", "memory.max"), "utf8")).toBe(String(512 * MIB));
        expect(readFileSync(join(base, "fleet-my-app", "memory.swap.max"), "utf8")).toBe("0");
        expect(readFileSync(join(base, "fleet-my-app", "cgroup.procs"), "utf8")).toBe("5151");

        // A real cgroup directory is empty once its processes exit; here the files stand in for them.
        rmSync(join(base, "fleet-my-app"), { recursive: true });
        cgroups.release("my-app");
        cgroups.release("never-attached");

        expect(cgroups.pathOf("my-app")).toBe(join(base, "fleet-my-app"));
    });

    it.each([
        ["0::/user.slice/user-1000.slice/session-2.scope\n", /not running as a systemd service/u],
        ["", /no cgroup v2 hierarchy/u],
        ["0::/system.slice/other.service\n", /cannot read/u],
    ])("refuses %j", (procSelfCgroup, reason) => {
        expect.assertions(1);

        expect(() => CgroupManager.setUp({ memoryMax: MIB, pid: 1, procSelfCgroup, root })).toThrow(reason);
    });

    it("refuses a service the memory controller is not delegated to", () => {
        expect.assertions(1);

        writeFileSync(join(root, service, "cgroup.controllers"), "cpu pids\n");

        expect(() => CgroupManager.setUp({ memoryMax: MIB, pid: 1, procSelfCgroup: `0::${service}\n`, root })).toThrow(/memory controller is not delegated/u);
    });

    it("gives a fleet the box's memory less a reserve by default, never under 256 MiB", () => {
        expect.assertions(3);

        expect(fleetMemoryMax(2048 * MIB)).toBe(1536 * MIB);
        expect(fleetMemoryMax(600 * MIB)).toBe(256 * MIB);
        expect(fleetMemoryMax(2048 * MIB, 700)).toBe(700 * MIB);
    });
});

describe(decideIsolation, () => {
    const ok = { ok: true } as const;
    const failed = { ok: false, reason: "no" } as const;

    it.each<[string, IsolationChecks, boolean, string, boolean]>([
        ["every check passes", { cgroup: ok, egress: ok, user: ok }, false, "enforced", true],
        ["every check passes on a single-trust box", { cgroup: ok, egress: ok, user: ok }, true, "enforced", true],
        ["the egress table is missing", { cgroup: ok, egress: failed, user: ok }, false, "refused", false],
        ["the egress table is missing on a single-trust box", { cgroup: ok, egress: failed, user: ok }, true, "single-trust", true],
        ["the uid drop fails", { cgroup: ok, egress: failed, user: failed }, false, "refused", false],
        ["no cgroup delegation", { cgroup: failed, egress: ok, user: ok }, false, "refused", false],
        ["nothing works on a single-trust box", { cgroup: failed, egress: failed, user: failed }, true, "single-trust", true],
    ])("%s", (_name, checks, singleTrust, expected, startsFleets) => {
        expect.assertions(1);

        expect(decideIsolation(checks, singleTrust)).toMatchObject({ startsFleets, status: expected });
    });

    it("names each failed check in order, and caps what hello carries", () => {
        expect.assertions(3);

        const report = decideIsolation({ cgroup: { ok: false, reason: "c" }, egress: { ok: true }, user: { ok: false, reason: "u" } }, false);

        expect(report.problems).toStrictEqual(["fleet user: u", "memory limits: c"]);

        const crowded = helloIsolation({ problems: Array.from({ length: 12 }, () => "x".repeat(2000)), startsFleets: false, status: "refused" });

        expect(crowded.problems).toHaveLength(8);
        expect(helloIsolation({ problems: [], startsFleets: true, status: "enforced" })).toStrictEqual({ status: "enforced" });
    });
});

describe(setUpIsolation, () => {
    let root: string;
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const service = "/system.slice/lunora-hostd.service";

    const configFor = (singleTrust: boolean) =>
        parseHostdConfig({
            boxId: "box_1",
            bucket: { endpoint: "http://127.0.0.1:19000", name: "b" },
            controlPlane: "https://cloud.example",
            credentialsFile: join(root, "etc", "bucket.env"),
            dataDir: join(root, "data"),
            hostname: "b.boxes.example",
            keyFile: join(root, "etc", "box.key"),
            singleTrust,
        });

    /** A box where everything works: the unit's capabilities, a fleet user (this test's own uid), nft, a delegated cgroup. */
    const system = (
        overrides: Partial<IsolationSystem> = {},
        probed = status(uid, "0000000000000000", "0000000000000000", 1),
    ): IsolationSystem & { scripts: string[] } => {
        const scripts: string[] = [];

        return {
            cgroupRoot: join(root, "cgroup"),
            firewall: {
                apply: async (script) => {
                    scripts.push(script);
                },
                present: async () => true,
                resolve: async () => {
                    return { ipv4: ["127.0.0.1"], ipv6: [] };
                },
            },
            pid: 77,
            probe: async () => probed,
            readText: (path) => {
                const files: Record<string, string> = {
                    "/etc/passwd": `lunora-fleet:x:${String(uid)}:${String(gid)}::/nonexistent:/usr/sbin/nologin\n`,
                    "/proc/self/cgroup": `0::${service}\n`,
                    "/proc/self/status": status(uid + 1, UNIT_CAPABILITIES, UNIT_CAPABILITIES, 1),
                };

                return files[path];
            },
            scripts,
            setpriv: "/usr/bin/setpriv",
            totalMemoryBytes: 2048 * MIB,
            ...overrides,
        };
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-isolation-"));
        mkdirSync(join(root, "cgroup", service), { recursive: true });
        writeFileSync(join(root, "cgroup", service, "cgroup.controllers"), "memory pids\n");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("enforces isolation when every check passes: fleets as their own user without capabilities, Caddy with only port binding", async () => {
        expect.assertions(6);

        const box = system();
        const isolation = await setUpIsolation(configFor(false), silentLogger, box);

        isolation.stop();

        expect(isolation.report).toStrictEqual({ problems: [], startsFleets: true, status: "enforced" });
        expect(isolation.fleet).toStrictEqual({ gid, prefix: dropCapabilitiesPrefix("/usr/bin/setpriv"), uid });
        expect(isolation.caddy).toStrictEqual({ prefix: dropCapabilitiesPrefix("/usr/bin/setpriv", ["net_bind_service"]) });
        expect(box.scripts[0]).toContain(`meta skuid != ${String(uid)} return`);
        expect(isolation.cgroups?.base).toBe(join(root, "cgroup", service));
        // The fleet group may pass through the data directory, never list it.
        expect(permissionsOf(statSync(join(root, "data", "fleets")).mode)).toBe(0o710);
    });

    it("refuses fleets when a process started as the fleet user keeps a capability", async () => {
        expect.assertions(2);

        const isolation = await setUpIsolation(configFor(false), silentLogger, system({}, status(uid, "0000000000001000", "0000000000001000", 1)));

        expect(isolation.report).toMatchObject({ startsFleets: false, status: "refused" });
        expect(isolation.report.problems).toStrictEqual([
            "fleet user: a process started as lunora-fleet kept capabilities or may gain new ones",
            "egress policy: not applied: fleets do not run as their own user",
        ]);
    });

    it("runs fleets anyway on a single-trust box, as the daemon's user but still without its capabilities", async () => {
        expect.assertions(3);

        const isolation = await setUpIsolation(
            configFor(true),
            silentLogger,
            system({ readText: (path) => (path === "/proc/self/status" ? status(5, UNIT_CAPABILITIES, UNIT_CAPABILITIES) : undefined) }),
        );

        expect(isolation.report).toMatchObject({ startsFleets: true, status: "single-trust" });
        expect(isolation.report.problems[0]).toBe("fleet user: no local user lunora-fleet (install.sh creates it)");
        expect(isolation.fleet).toStrictEqual({ prefix: dropCapabilitiesPrefix("/usr/bin/setpriv") });
    });

    it("starts children through setpriv even when the daemon holds no capabilities, so they run with no_new_privs", async () => {
        expect.assertions(2);

        const isolation = await setUpIsolation(
            configFor(false),
            silentLogger,
            system({
                readText: (path) => {
                    const files: Record<string, string> = {
                        "/etc/passwd": `lunora-fleet:x:${String(uid)}:${String(gid)}::/nonexistent:/usr/sbin/nologin\n`,
                        "/proc/self/cgroup": `0::${service}\n`,
                        "/proc/self/status": status(0, "000001ffffffffff", "0000000000000000"),
                    };

                    return files[path];
                },
            }),
        );

        isolation.stop();

        expect(isolation.fleet.prefix).toStrictEqual(dropCapabilitiesPrefix("/usr/bin/setpriv"));
        expect(isolation.caddy.prefix).toStrictEqual(dropCapabilitiesPrefix("/usr/bin/setpriv"));
    });

    it("refuses when setpriv is missing, since children would inherit the daemon's capabilities", async () => {
        expect.assertions(1);

        const isolation = await setUpIsolation(configFor(false), silentLogger, system({ setpriv: undefined }));

        expect(isolation.report.problems[0]).toMatch(/^fleet user: setpriv \(util-linux\) is not installed/u);
    });

    it("refuses when the daemon cannot switch to the fleet user", async () => {
        expect.assertions(1);

        const isolation = await setUpIsolation(
            configFor(false),
            silentLogger,
            system({
                probe: async () => {
                    throw new Error("spawn EPERM");
                },
            }),
        );

        expect(isolation.report.problems[0]).toMatch(/cannot start a process as lunora-fleet \(spawn EPERM\); the daemon needs CAP_SETUID/u);
    });
});

describe("the fleet's files", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-hostd-files-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("shares a release with the fleet group (dirs 0750, files 0640) and keeps the working directory private (0700)", () => {
        expect.assertions(4);

        const account = { gid: process.getgid?.() ?? 1000, uid: process.getuid?.() ?? 1000, user: "lunora-fleet" };
        const release = join(root, "releases", "dep_1");

        mkdirSync(join(release, "assets"), { recursive: true });
        writeFileSync(join(release, "wrangler.json"), "{}", { mode: 0o600 });
        writeFileSync(join(release, "assets", "a.css"), "", { mode: 0o600 });
        shareWithFleet(release, account);

        expect(permissionsOf(statSync(join(release, "assets")).mode)).toBe(0o750);
        expect(permissionsOf(statSync(join(release, "wrangler.json")).mode)).toBe(0o640);

        const directory = ensureFleetDirectory(root, "my-app", account);

        expect(directory).toBe(join(root, "fleets", "my-app"));
        expect(permissionsOf(statSync(directory).mode)).toBe(0o700);
    });
});
