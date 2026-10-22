import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevPorts } from "../../../shared/dev-ports";
import {
    BLOCKED_PORTS,
    derivePortOffset,
    describeDevPorts,
    findCheckoutRoot,
    LEGACY_PLAYGROUND_PORT,
    LEGACY_STUDIO_PORT,
    PINNED_PORT_BASES,
    resolveDevPorts,
    servedPlaygroundPort,
    shiftedPort,
    staleDevOrigin,
} from "../../../shared/dev-ports";

/** The explicit offsets the blocked-port check is exercised over. */
const EXPLICIT_OFFSETS = 2999;

const offsets = Array.from({ length: EXPLICIT_OFFSETS }, (_, index) => index + 1);

/** Every base the pair and the pinned ports start from, before any offset moves them. */
const ALL_BASES: ReadonlyArray<number> = [LEGACY_PLAYGROUND_PORT, LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES];

const pairIsBlocked = (offset: number): boolean => ALL_BASES.some((base) => BLOCKED_PORTS.has(base + offset));

/** The resolved pair for an explicit offset, or `undefined` when the offset is rejected. */
const tryExplicitOffset = (offset: number): DevPorts | undefined => {
    try {
        return resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: String(offset) }, linked: false, root: "/x" });
    } catch {
        return undefined;
    }
};

describe("derivePortOffset", () => {
    it("is deterministic for a path and distinct across paths", () => {
        expect.hasAssertions();

        const roots = ["/work/alpha", "/work/beta", "/work/gamma", "/work/delta", "/work/epsilon"];
        const derived = roots.map((root) => derivePortOffset(root));

        expect(derived).toStrictEqual(roots.map((root) => derivePortOffset(root)));
        expect(new Set(derived).size).toBe(roots.length);
    });

    it("never yields a browser-blocked pair, or a pair whose shifted ports land on the main checkout's", () => {
        expect.hasAssertions();

        const accepted = offsets.map((offset) => tryExplicitOffset(offset)).filter((ports): ports is DevPorts => ports !== undefined);
        const mainPorts = new Set(ALL_BASES);
        const collides = (ports: DevPorts): boolean => ALL_BASES.some((base) => mainPorts.has(shiftedPort(base, ports)));

        expect(accepted.length).toBeGreaterThan(0);
        expect(accepted.some((ports) => BLOCKED_PORTS.has(ports.playground) || BLOCKED_PORTS.has(ports.studio))).toBe(false);
        expect(accepted.some((ports) => collides(ports))).toBe(false);
        expect(accepted.every((ports) => ports.studio <= 65_535)).toBe(true);

        const derived = derivePortOffset("/some/worktree");

        expect(derived).toBeGreaterThan(0);
        expect(pairIsBlocked(derived)).toBe(false);
    });

    it("keeps every pinned port usable at the derived offset", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: {}, linked: true, root: "/some/worktree" });
        const unusable = PINNED_PORT_BASES.map((base) => shiftedPort(base, ports)).filter((port) => BLOCKED_PORTS.has(port) || port > 65_535);

        expect(unusable).toStrictEqual([]);
    });

    it("keeps every derivable checkout, and the main one, on disjoint usable ports", () => {
        expect.hasAssertions();

        // Every offset a root can hash to, found by probing roots until the set stops growing.
        const derivable = new Set<number>([0]);

        for (let index = 0; index < 20_000; index += 1) {
            derivable.add(derivePortOffset(`/probe/${String(index)}`));
        }

        const owners = new Map<number, number>();
        const ports = [LEGACY_PLAYGROUND_PORT, LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES];

        for (const offset of derivable) {
            for (const base of ports) {
                const port = base + offset;

                expect(port).toBeLessThanOrEqual(65_535);
                expect(BLOCKED_PORTS.has(port)).toBe(false);
                // Two checkouts sharing a port would fail the second one's strictPort start.
                expect(owners.get(port) ?? offset).toBe(offset);

                owners.set(port, offset);
            }
        }

        expect(derivable.size).toBeGreaterThan(200);
    });
});

describe("resolveDevPorts", () => {
    it("returns the legacy 5173/5174 pair for the main checkout", () => {
        expect.hasAssertions();

        expect(resolveDevPorts({ env: {}, linked: false, root: "/main" })).toStrictEqual({
            offset: 0,
            playground: LEGACY_PLAYGROUND_PORT,
            source: "legacy",
            studio: LEGACY_STUDIO_PORT,
        });
    });

    it("returns the legacy pair under CI even inside a linked worktree", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: { CI: "true" }, linked: true, root: "/worktree" });

        expect([ports.playground, ports.studio, ports.source]).toStrictEqual([5173, 5174, "legacy"]);
    });

    it("derives a non-legacy pair inside a linked worktree", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: {}, linked: true, root: "/worktree" });

        expect(ports.source).toBe("derived");
        expect(ports.playground).toBe(LEGACY_PLAYGROUND_PORT + ports.offset);
        expect(ports.studio).toBe(LEGACY_STUDIO_PORT + ports.offset);
        expect(ports.offset).not.toBe(0);
    });

    it("lets LUNORA_DEV_PORT_OFFSET win over the worktree hash and over CI", () => {
        expect.hasAssertions();

        expect(resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "7" }, linked: true, root: "/worktree" })).toStrictEqual({
            offset: 7,
            playground: 5180,
            source: "env",
            studio: 5181,
        });
        expect(resolveDevPorts({ env: { CI: "1", LUNORA_DEV_PORT_OFFSET: "7" }, linked: false, root: "/main" }).playground).toBe(5180);
    });

    it("forces the legacy pair with LUNORA_DEV_PORT_OFFSET=0 even inside a linked worktree", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "0" }, linked: true, root: "/worktree" });

        expect([ports.playground, ports.studio, ports.source]).toStrictEqual([5173, 5174, "legacy"]);
    });

    it("rejects an explicit offset that lands a pinned port on another pinned port, and keeps the stride", () => {
        expect.hasAssertions();

        // 1: studio 5174 + 1 = 5175, the blog's pinned port. 2: playground 5173 + 2 = 5175.
        // 100: playground 5173 + 100 = 5273, an e2e example's pinned port.
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "1" }, linked: true, root: "/worktree" })).toThrow(/pinned port/u);
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "2" }, linked: false, root: "/x" })).toThrow(/pinned port/u);
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "100" }, linked: false, root: "/x" })).toThrow(/pinned port/u);

        // The whole low end, both sides: 1 to 5 are the differences between the bases, 6 to 10 are not.
        for (const offset of [1, 2, 3, 4, 5]) {
            expect(tryExplicitOffset(offset)).toBeUndefined();
        }
        for (const offset of [6, 7, 8, 9, 10]) {
            expect(tryExplicitOffset(offset)).toBeDefined();
        }

        // The derived stride never collides with a pinned port, so an offset of 200 is accepted.
        expect(resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "200" }, linked: false, root: "/x" }).playground).toBe(5373);

        // 201 moves the playground onto 5374, the studio port a checkout assigned the derived offset 200 owns.
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "201" }, linked: false, root: "/x" })).toThrow(/pinned port/u);
    });

    it("rejects a malformed or browser-blocked explicit offset instead of drifting", () => {
        expect.hasAssertions();

        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "abc" }, linked: false, root: "/x" })).toThrow(/non-negative integer/u);
        // 827 + 5173 = 6000, a browser-blocked playground port.
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "827" }, linked: false, root: "/x" })).toThrow(/browser-blocked/u);
    });

    it("describes the pair on one line", () => {
        expect.hasAssertions();

        const line = describeDevPorts(resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "7" }, linked: false, root: "/x" }));

        expect(line).toBe("dev ports: playground :5180, studio :5181 (offset 7, env)");
    });
});

describe("findCheckoutRoot", () => {
    const made: string[] = [];

    const tempRepo = (): string => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "dev-ports-")));

        made.push(dir);

        return dir;
    };

    afterEach(() => {
        for (const dir of made.splice(0)) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    it("reports a main checkout when .git is a directory", () => {
        expect.hasAssertions();

        const repo = tempRepo();

        mkdirSync(join(repo, ".git"));
        mkdirSync(join(repo, "apps", "playground"), { recursive: true });

        expect(findCheckoutRoot(join(repo, "apps", "playground"))).toStrictEqual({ linked: false, root: repo });
    });

    it("reports a linked worktree when .git is a file", () => {
        expect.hasAssertions();

        const worktree = tempRepo();

        writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
        mkdirSync(join(worktree, "apps", "studio"), { recursive: true });

        expect(findCheckoutRoot(join(worktree, "apps", "studio"))).toStrictEqual({ linked: true, root: worktree });
    });

    it("treats a submodule's .git file as a main checkout, since it points into modules/", () => {
        expect.hasAssertions();

        const submodule = tempRepo();

        writeFileSync(join(submodule, ".git"), "gitdir: ../.git/modules/lib\n");

        expect(findCheckoutRoot(submodule)).toStrictEqual({ linked: false, root: submodule });
    });

    it("returns undefined outside any checkout", () => {
        expect.hasAssertions();

        const bare = tempRepo();

        expect(findCheckoutRoot(bare)).toBeUndefined();
    });
});

describe("staleDevOrigin", () => {
    const origin = (value: string, quote = ""): string => `LUNORA_ORIGIN_URL=${quote}${value}${quote}`;

    it("reports a loopback origin on another port, quoted or bare", () => {
        expect.hasAssertions();
        expect(staleDevOrigin(`${origin("http://localhost:5173", '"')}\n`, 7309)).toBe("http://localhost:5173");
        expect(staleDevOrigin(`A=1\n${origin("http://127.0.0.1:5173")} # dev\n`, 7309)).toBe("http://127.0.0.1:5173");
    });

    it("stays silent when the port matches, the host is remote, or the variable is absent or commented out", () => {
        expect.hasAssertions();
        expect(staleDevOrigin(origin("http://localhost:7309", '"'), 7309)).toBeUndefined();
        expect(staleDevOrigin(origin("https://app.example.com", '"'), 7309)).toBeUndefined();
        expect(staleDevOrigin("AUTH_URL=http://localhost:5173", 7309)).toBeUndefined();
        expect(staleDevOrigin(`# ${origin("http://localhost:5173")}`, 7309)).toBeUndefined();
        expect(staleDevOrigin("LUNORA_ORIGIN_URL=", 7309)).toBeUndefined();
    });
});

describe("servedPlaygroundPort", () => {
    const ports: DevPorts = { offset: 2, playground: 7309, source: "derived", studio: 7310 };

    it("serves the derived port when no e2e origin is pinned", () => {
        expect.hasAssertions();
        expect(servedPlaygroundPort(ports, {})).toBe(7309);
        expect(servedPlaygroundPort(ports, { LUNORA_E2E_BASE_URL: "" })).toBe(7309);
    });

    it("serves the port of a pinned e2e origin, so the harness's own origin is not reported stale", () => {
        expect.hasAssertions();
        expect(servedPlaygroundPort(ports, { LUNORA_E2E_BASE_URL: "http://localhost:4173" })).toBe(4173);
    });

    it("falls back to the derived port for a portless or malformed pinned origin", () => {
        expect.hasAssertions();
        expect(servedPlaygroundPort(ports, { LUNORA_E2E_BASE_URL: "https://preview.example" })).toBe(7309);
        expect(servedPlaygroundPort(ports, { LUNORA_E2E_BASE_URL: "not a url" })).toBe(7309);
    });
});
