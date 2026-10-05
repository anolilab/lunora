/**
 * Who may reach what on an installed box (plan 458 W8), computed from owners
 * and modes alone — so a layout that keeps a child from starting, or lets one
 * reach too far, fails here, without root, and not only on the `hostd`
 * lane's root variant.
 *
 * The layout is the one install.sh creates (its `install -d` lines, parsed),
 * the one hostd creates for fleets and releases (by running the code and
 * reading the modes it set), and the files written with fixed modes. The
 * unit grants the daemon no `CAP_DAC_*`, so every user here — the daemon
 * included — is held to plain owner/group/other permissions.
 *
 * Children are checked as Node starts them: the spawning process executes
 * the launcher and enters the `cwd` it is handed *before* the uid change (as
 * the daemon), then the child — as its own user — enters the directory
 * `env --chdir` names and executes its binary. The spawns are those the
 * supervisor makes (captured through its injected `spawn`) and those
 * `runChild` makes (the same `launchCommand`).
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChildLaunch } from "../src/daemon/capabilities";
import { CHDIR_COMMAND, dropCapabilitiesPrefix, launchCommand } from "../src/daemon/capabilities";
import { DEFAULT_DATA_DIR, DEFAULT_INSTALL_DIR, parseHostdConfig } from "../src/daemon/config";
import { edgePaths } from "../src/daemon/edge";
import { ensureFleetDirectory, prepareDataDirectory, shareWithFleet } from "../src/daemon/fleet-directories";
import { silentLogger } from "../src/daemon/log";
import { Supervisor } from "../src/daemon/supervisor";

type Who = "daemon" | "edge" | "fleet" | "root";

/** One path's owner, group and permission bits. */
interface Entry {
    group: Who;
    mode: number;
    owner: Who;
}

const script = readFileSync(new URL("../install/install.sh", import.meta.url), "utf8");
const unit = readFileSync(new URL("../install/lunora-hostd.service", import.meta.url), "utf8");

const SETPRIV = "/usr/bin/setpriv";
const RELEASE = join(DEFAULT_INSTALL_DIR, "rel_1");
const CURRENT = join(DEFAULT_INSTALL_DIR, "current");
const CONFIG_DIR = "/etc/lunora-hostd";
const ALIAS = "my-app";
const FLEET_DIR = join(DEFAULT_DATA_DIR, "fleets", ALIAS);
const RELEASE_DIR = join(DEFAULT_DATA_DIR, "releases", "dep_1");
const EDGE = edgePaths(DEFAULT_DATA_DIR);

/** The capabilities that would let the daemon past file permissions. */
const DAC_BYPASS = new Set(["CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER"]);

const layout = new Map<string, Entry>();

const ROOT_DIRECTORY: Entry = { group: "root", mode: 0o755, owner: "root" };

/** Every directory on the way to the paths below exists and is root's, 0755, unless set otherwise. */
const add = (path: string, entry: Entry): void => {
    for (let parent = dirname(path); !layout.has(parent); parent = dirname(parent)) {
        layout.set(parent, ROOT_DIRECTORY);
    }

    layout.set(path, entry);
};

/** `/opt/lunora-hostd/current` is a link to the release that runs. */
const resolve = (path: string): string => (path.startsWith(`${CURRENT}/`) ? join(RELEASE, path.slice(CURRENT.length + 1)) : path);

type Permission = "r" | "w" | "x";

/** Whether `who` holds every one of `wanted` on `path` by its permission bits (`x` on a directory: search). */
const holds = (who: Who, path: string, wanted: ReadonlyArray<Permission>): boolean => {
    const entry = layout.get(resolve(path));

    if (entry === undefined) {
        throw new Error(`${path} is not in the layout`);
    }

    if (who === "root") {
        return true;
    }

    // Each user's only group is its own (useradd --user-group, no supplementary groups).
    let level = 0;

    if (entry.owner === who) {
        level = 2;
    } else if (entry.group === who) {
        level = 1;
    }

    const triplet = Math.floor(entry.mode / 8 ** level) % 8;
    const granted = new Set((["r", "w", "x"] as const).filter((_, index) => Math.floor(triplet / 2 ** (2 - index)) % 2 === 1));

    return wanted.every((permission) => granted.has(permission));
};

/** Whether `who` may search every directory above `path`. */
const reaches = (who: Who, path: string): boolean => {
    const resolved = resolve(path);
    const parents: string[] = [];

    for (let parent = dirname(resolved); parent !== dirname(parent); parent = dirname(parent)) {
        parents.push(parent);
    }

    return [...parents, "/"].every((parent) => holds(who, parent, ["x"]));
};

const can = {
    /** Enter it (`chdir`) or pass through it. */
    enter: (who: Who, path: string): boolean => reaches(who, path) && holds(who, path, ["x"]),
    execute: (who: Who, path: string): boolean => reaches(who, path) && holds(who, path, ["x"]),
    /** List a directory, or read a file. */
    read: (who: Who, path: string): boolean => reaches(who, path) && holds(who, path, ["r"]),
    /** Create, replace or remove entries in a directory. */
    write: (who: Who, path: string): boolean => reaches(who, path) && holds(who, path, ["w", "x"]),
};

/** How a child is spawned, as Node is handed it. */
interface Spawn {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    name: string;
    who: Who;
}

/**
 * What goes wrong starting `spawn`, as Node and the kernel would see it: the
 * daemon executes the launcher and enters `cwd` (before the uid change), then
 * the child enters its `--chdir` directory and executes its program as itself.
 */
const startProblems = (spawn: Spawn): string[] => {
    const problems: string[] = [];

    if (!can.execute("daemon", spawn.command)) {
        problems.push(`the daemon cannot execute ${spawn.command}`);
    }

    if (spawn.cwd !== undefined && !can.enter("daemon", spawn.cwd)) {
        problems.push(`Node enters ${spawn.cwd} as the daemon, before switching to ${spawn.who}, and the daemon may not (spawn ${spawn.command} EACCES)`);
    }

    const chdir = spawn.args.find((argument) => argument.startsWith("--chdir="))?.slice("--chdir=".length);

    if (chdir !== undefined && !can.enter(spawn.who, chdir)) {
        problems.push(`${spawn.who} cannot enter ${chdir}`);
    }

    // The program the chain ends in: after setpriv's `--`, then after env's.
    const program = spawn.args.slice(spawn.args.lastIndexOf("--") + 1)[0] ?? spawn.command;

    if (program.startsWith("/") && !can.execute(spawn.who, program)) {
        problems.push(`${spawn.who} cannot execute ${program}`);
    }

    return problems;
};

// eslint-disable-next-line unicorn/prefer-event-target -- it stands in for a ChildProcess, which is an EventEmitter
class FakeChild extends EventEmitter {
    public readonly stderr = new PassThrough();

    public readonly stdout = new PassThrough();
}

let scratch: string;
const spawns: Spawn[] = [];

describe("access on an installed box", () => {
    beforeAll(() => {
        // install.sh's `install -d -o OWNER -g GROUP -m MODE DIR` lines.
        const variables: Record<string, string> = Object.fromEntries([...script.matchAll(/^([A-Z_]+)="([^"$]+)"$/gmu)].map(([, name, value]) => [name, value]));
        const users: Record<string, Who> = { EDGE_USER: "edge", FLEET_USER: "fleet", HOSTD_USER: "daemon" };

        for (const [, owner = "", group = "", mode = "", base = "", rest = ""] of script.matchAll(
            /^ {4}install -d -o "\$\{(\w+)\}" -g "\$\{(\w+)\}" -m (\d+) "\$\{(\w+)\}((?:\/[\w/]+)?)"$/gmu,
        )) {
            add(`${variables[base] ?? base}${rest}`, { group: users[group] as Who, mode: Number.parseInt(mode, 8) % 0o1000, owner: users[owner] as Who });
        }

        // What hostd creates, with the modes its own code sets (owners as it chowns them).
        scratch = mkdtempSync(join(tmpdir(), "lunora-hostd-access-"));

        const me = { gid: process.getgid?.() ?? 1000, uid: process.getuid?.() ?? 1000, user: "lunora-fleet" };
        const local = join(scratch, "data");
        const permissions = (path: string): number => statSync(join(local, path)).mode % 0o1000;

        mkdirSync(local);
        prepareDataDirectory(local, me);
        ensureFleetDirectory(local, ALIAS, me);
        mkdirSync(join(local, "releases", "dep_1"));
        writeFileSync(join(local, "releases", "dep_1", "worker.js"), "", { mode: 0o600 });
        shareWithFleet(join(local, "releases", "dep_1"), me);

        for (const path of ["fleets", "releases"]) {
            add(join(DEFAULT_DATA_DIR, path), { group: "fleet", mode: permissions(path), owner: "daemon" });
        }

        add(FLEET_DIR, { group: "fleet", mode: permissions(join("fleets", ALIAS)), owner: "fleet" });
        add(RELEASE_DIR, { group: "fleet", mode: permissions(join("releases", "dep_1")), owner: "daemon" });
        add(join(RELEASE_DIR, "worker.js"), { group: "fleet", mode: permissions(join("releases", "dep_1", "worker.js")), owner: "daemon" });

        // Files written with fixed modes: the key and credentials, state, Caddy's config and access log,
        // and a release's binaries (release-install.ts: directory and binaries 0755).
        add(join(CONFIG_DIR, "box.key"), { group: "daemon", mode: 0o600, owner: "daemon" });
        add(join(CONFIG_DIR, "bucket.env"), { group: "daemon", mode: 0o600, owner: "daemon" });
        add(join(DEFAULT_DATA_DIR, "state.json"), { group: "daemon", mode: 0o600, owner: "daemon" });
        add(EDGE.config, { group: "edge", mode: 0o640, owner: "daemon" });
        add(EDGE.accessLog, { group: "daemon", mode: 0o640, owner: "edge" });
        add(RELEASE, { group: "daemon", mode: 0o755, owner: "daemon" });

        for (const binary of ["lunora-hostd", "celld", "caddy"]) {
            add(join(RELEASE, binary), { group: "daemon", mode: 0o755, owner: "daemon" });
        }

        add(SETPRIV, { group: "root", mode: 0o755, owner: "root" });
        add(CHDIR_COMMAND, { group: "root", mode: 0o755, owner: "root" });

        // The supervisor's spawns, isolated the way setUpIsolation isolates them (uids are this test's own).
        const config = parseHostdConfig({
            boxId: "box_1",
            bucket: { name: "b" },
            controlPlane: "https://cloud.example",
            credentialsFile: join(CONFIG_DIR, "bucket.env"),
            dataDir: local,
            hostname: "bx.boxes.lunora.app",
            keyFile: join(CONFIG_DIR, "box.key"),
        });
        const fleet: ChildLaunch = { gid: me.gid, prefix: dropCapabilitiesPrefix(SETPRIV), uid: me.uid };
        const caddy: ChildLaunch = { gid: me.gid, prefix: dropCapabilitiesPrefix(SETPRIV, ["net_bind_service"]), uid: me.uid };
        const recorded: { args: ReadonlyArray<string>; command: string; options: SpawnOptions }[] = [];
        const supervisor = new Supervisor({
            config,
            credentials: () => {
                return {};
            },
            logger: silentLogger,
            spawn: (command, args, options) => {
                recorded.push({ args, command, options });

                return new FakeChild() as unknown as ChildProcess;
            },
        });
        // Paths under the scratch data directory, as they are on a box.
        const onBox = (text: string): string => text.replaceAll(local, DEFAULT_DATA_DIR);

        supervisor.isolate({ account: me, caddy, fleet });
        supervisor.startFleet({ alias: ALIAS, internalPort: 20_001, publicPort: 20_000 });
        supervisor.startCaddy(EDGE.config);

        for (const [index, { args, command, options }] of recorded.entries()) {
            spawns.push({
                args: args.map((argument) => onBox(argument)),
                command,
                ...(typeof options.cwd === "string" ? { cwd: onBox(options.cwd) } : {}),
                name: index === 0 ? "a fleet's node" : "Caddy",
                who: index === 0 ? "fleet" : "edge",
            });
        }

        // runChild's spawns: celld deploy / diagnose in the fleet's directory, find emptying it.
        for (const [name, command, args, cwd] of [
            ["celld deploy", join(CURRENT, "celld"), ["deploy", RELEASE_DIR], FLEET_DIR],
            ["find", "find", [FLEET_DIR, "-mindepth", "1", "-delete"], undefined],
        ] as const) {
            spawns.push({ ...launchCommand(fleet, command, args, cwd), name, who: "fleet" });
        }
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("holds the daemon to plain file permissions: the unit grants it no CAP_DAC_*", () => {
        expect.assertions(1);

        const granted = /^CapabilityBoundingSet=(.*)$/mu.exec(unit)?.[1]?.split(" ") ?? [];

        expect(granted.filter((capability) => DAC_BYPASS.has(capability))).toStrictEqual([]);
    });

    it("starts every child: what Node enters as the daemon, the daemon may enter; the rest the child does as itself", () => {
        expect.assertions(2);

        expect(spawns.map((spawn) => spawn.name)).toStrictEqual(["a fleet's node", "Caddy", "celld deploy", "find"]);
        expect(Object.fromEntries(spawns.map((spawn) => [spawn.name, startProblems(spawn)]))).toStrictEqual({
            "a fleet's node": [],
            Caddy: [],
            "celld deploy": [],
            find: [],
        });
    });

    it("would refuse a child whose working directory Node enters as the daemon (the lane's spawn setpriv EACCES)", () => {
        expect.assertions(2);

        expect(startProblems({ args: ["--", join(CURRENT, "celld")], command: SETPRIV, cwd: FLEET_DIR, name: "", who: "fleet" })).toHaveLength(1);
        expect(startProblems({ args: ["--", join(CURRENT, "caddy")], command: SETPRIV, cwd: EDGE.state, name: "", who: "edge" })).toHaveLength(1);
    });

    it("gives a fleet its working directory and its release, read-only, and nothing of the key, the state or Caddy's", () => {
        expect.assertions(2);

        expect([can.write("fleet", FLEET_DIR), can.read("fleet", FLEET_DIR), can.read("fleet", join(RELEASE_DIR, "worker.js"))]).toStrictEqual([
            true,
            true,
            true,
        ]);
        expect([
            can.write("fleet", RELEASE_DIR),
            can.read("fleet", DEFAULT_DATA_DIR),
            can.read("fleet", join(DEFAULT_DATA_DIR, "fleets")),
            can.read("fleet", join(DEFAULT_DATA_DIR, "releases")),
            can.read("fleet", join(DEFAULT_DATA_DIR, "state.json")),
            can.enter("fleet", CONFIG_DIR),
            can.read("fleet", join(CONFIG_DIR, "box.key")),
            can.read("fleet", join(CONFIG_DIR, "bucket.env")),
            can.enter("fleet", EDGE.home),
        ]).toStrictEqual(Array.from<boolean>({ length: 9 }).fill(false));
    });

    it("gives Caddy its config to read, its state and log to write, and nothing of hostd's or the fleets'", () => {
        expect.assertions(2);

        expect([
            can.read("edge", EDGE.config),
            can.write("edge", EDGE.state),
            can.write("edge", EDGE.log),
            can.execute("edge", join(CURRENT, "caddy")),
        ]).toStrictEqual([true, true, true, true]);
        expect([
            can.write("edge", EDGE.home),
            can.read("edge", DEFAULT_DATA_DIR),
            can.enter("edge", join(DEFAULT_DATA_DIR, "fleets")),
            can.enter("edge", join(DEFAULT_DATA_DIR, "releases")),
            can.read("edge", join(DEFAULT_DATA_DIR, "state.json")),
            can.enter("edge", CONFIG_DIR),
            can.read("edge", join(CONFIG_DIR, "box.key")),
        ]).toStrictEqual(Array.from<boolean>({ length: 7 }).fill(false));
    });

    it("lets the daemon manage the directories it owns, and never write where Caddy can, or into a fleet's directory", () => {
        expect.assertions(2);

        expect([
            can.read("daemon", join(CONFIG_DIR, "box.key")),
            can.write("daemon", join(DEFAULT_DATA_DIR, "fleets")),
            can.write("daemon", join(DEFAULT_DATA_DIR, "releases")),
            can.write("daemon", EDGE.home),
            can.read("daemon", EDGE.accessLog),
            can.write("daemon", DEFAULT_INSTALL_DIR),
        ]).toStrictEqual([true, true, true, true, true, true]);
        // So the daemon removes a fleet's directory with rmdir once the fleet user has emptied it.
        expect([can.write("daemon", EDGE.state), can.write("daemon", EDGE.log), can.enter("daemon", FLEET_DIR), can.enter("daemon", EDGE.state)]).toStrictEqual(
            [false, false, false, false],
        );
    });
});
