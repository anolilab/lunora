/**
 * `install/install.sh` and `install/lunora-hostd.service` against the code
 * they install (plan 458 W7): the script pins the same release keys the binary
 * compiles in, writes the same unit the release publishes, and the unit gives
 * the daemon the paths, capabilities and stop budget it relies on. The script
 * itself runs on a real box in the `test:hostd` lane's workflow only as far as
 * a CI runner allows; shellcheck covers the rest.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { binaryPaths, DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR, DEFAULT_EDGE_USER, DEFAULT_FLEET_USER, DEFAULT_INSTALL_DIR } from "../src/daemon/config";
import { EDGE_DIRECTORIES } from "../src/daemon/edge";
import { NFT_TABLE } from "../src/daemon/nftables";
import { CADDY_STOP_BUDGET_MS, CELLD_STOP_BUDGET_MS } from "../src/daemon/supervisor";
import { HOSTD_TRUSTED_RELEASE_KEYS } from "../src/release";

const script = readFileSync(new URL("../install/install.sh", import.meta.url), "utf8");
const unit = readFileSync(new URL("../install/lunora-hostd.service", import.meta.url), "utf8");

/** `Key=value` lines of the unit's `[Service]` section. */
const service = new Map(
    unit
        .slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"))
        .split("\n")
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
);

const between = (text: string, start: string, end: string): string => text.slice(text.indexOf(start) + start.length, text.indexOf(end));

describe("install.sh", () => {
    it("pins exactly the release keys compiled into lunora-hostd", () => {
        expect.assertions(1);

        const block = between(script, "# BEGIN TRUSTED RELEASE KEYS", "# END TRUSTED RELEASE KEYS");
        const pinned = Object.fromEntries(
            [...block.matchAll(/^ {8}([\w.-]+)\)\n {12}printf '%s\\n' '([^']*)'\n {12};;$/gmu)].map((match) => [match[1], match[2]]),
        );

        expect(pinned).toStrictEqual(Object.fromEntries(Object.entries(HOSTD_TRUSTED_RELEASE_KEYS).map(([id, key]) => [id, key.trim()])));
    });

    it("writes the unit the release publishes, byte for byte", () => {
        expect.assertions(1);

        expect(`${between(script, "<<'UNIT'\n", "\nUNIT\n")}\n`).toBe(unit);
    });

    it("lays the box out where the daemon looks", () => {
        expect.assertions(6);

        const assignment = (name: string): string | undefined => new RegExp(`^${name}="([^"]+)"$`, "mu").exec(script)?.[1];

        expect(assignment("INSTALL_DIR")).toBe(DEFAULT_INSTALL_DIR);
        expect(assignment("DATA_DIR")).toBe(DEFAULT_DATA_DIR);
        expect(`${assignment("CONFIG_DIR") ?? ""}/config.json`).toBe(DEFAULT_CONFIG_PATH);
        expect(assignment("FLEET_USER")).toBe(DEFAULT_FLEET_USER);
        expect(assignment("EDGE_USER")).toBe(DEFAULT_EDGE_USER);
        expect(assignment("NFT_TABLE")).toBe(NFT_TABLE);
    });

    it("lays Caddy's directories out exactly as the daemon checks them, set-group-ID bits included", () => {
        expect.assertions(1);

        const users = { EDGE_USER: "edge", HOSTD_USER: "daemon" } as const;
        const created = [...script.matchAll(/^ {4}install -d -o "\$\{(\w+)\}" -g "\$\{(\w+)\}" -m (\d+) "\$\{DATA_DIR\}\/([\w/]+)"$/gmu)].map(
            ([, owner, group, mode, path]) => {
                return {
                    group: users[group as keyof typeof users],
                    mode: Number.parseInt(mode ?? "", 8),
                    owner: users[owner as keyof typeof users],
                    path,
                };
            },
        );

        expect(created).toStrictEqual([...EDGE_DIRECTORIES]);
    });
});

describe("lunora-hostd.service", () => {
    it("runs the current release's lunora-hostd as its own user, in a cgroup it may manage", () => {
        expect.assertions(4);

        expect(service.get("ExecStart")).toBe(`${binaryPaths({ installDir: DEFAULT_INSTALL_DIR }).hostd} run`);
        expect([service.get("User"), service.get("Group")]).toStrictEqual(["lunora-hostd", "lunora-hostd"]);
        expect(service.get("Delegate")).toBe("yes");
        expect(service.get("NoNewPrivileges")).toBe("yes");
    });

    it("grants the six capabilities the daemon uses, and bounds it to them", () => {
        expect.assertions(2);

        const capabilities = ["CAP_CHOWN", "CAP_KILL", "CAP_NET_ADMIN", "CAP_NET_BIND_SERVICE", "CAP_SETGID", "CAP_SETUID"];

        expect(service.get("AmbientCapabilities")?.split(" ").toSorted()).toStrictEqual(capabilities);
        expect(service.get("CapabilityBoundingSet")?.split(" ").toSorted()).toStrictEqual(capabilities);
    });

    it("may write only the data and install directories, not the key's", () => {
        expect.assertions(2);

        expect(service.get("ProtectSystem")).toBe("strict");
        expect(service.get("ReadWritePaths")?.split(" ")).toStrictEqual([DEFAULT_DATA_DIR, DEFAULT_INSTALL_DIR]);
    });

    it("waits out the supervisor's stop budget, and stays down after a revocation", () => {
        expect.assertions(2);

        expect(Number(service.get("TimeoutStopSec")) * 1000).toBeGreaterThanOrEqual(CELLD_STOP_BUDGET_MS + CADDY_STOP_BUDGET_MS);
        expect([service.get("Restart"), service.get("RestartPreventExitStatus")]).toStrictEqual(["always", "2"]);
    });
});
