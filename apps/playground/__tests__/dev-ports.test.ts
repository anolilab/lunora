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
    hashPortOffset,
    LEGACY_PLAYGROUND_PORT,
    LEGACY_STUDIO_PORT,
    PINNED_PORT_BASES,
    resolveDevPorts,
    shiftedPort,
} from "../../../shared/dev-ports";

const OFFSET_RANGE = 2999;

const offsets = Array.from({ length: OFFSET_RANGE }, (_, index) => index + 1);

const pairIsBlocked = (offset: number): boolean =>
    [LEGACY_PLAYGROUND_PORT, LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES].some((base) => BLOCKED_PORTS.has(base + offset));

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

    it("never yields a browser-blocked pair, and rejects only the blocked explicit offsets", () => {
        expect.hasAssertions();

        const accepted = offsets.map((offset) => tryExplicitOffset(offset)).filter((ports): ports is DevPorts => ports !== undefined);
        const rejectedCount = offsets.filter((offset) => pairIsBlocked(offset)).length;

        expect(accepted).toHaveLength(OFFSET_RANGE - rejectedCount);
        expect(accepted.some((ports) => BLOCKED_PORTS.has(ports.playground) || BLOCKED_PORTS.has(ports.studio))).toBe(false);
        expect(accepted.every((ports) => ports.studio <= 65_535)).toBe(true);

        const derived = derivePortOffset("/some/worktree");

        expect(derived).toBeGreaterThanOrEqual(1);
        expect(derived).toBeLessThanOrEqual(OFFSET_RANGE);
        expect(pairIsBlocked(derived)).toBe(false);
    });

    it("keeps every pinned port usable at the derived offset", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: {}, linked: true, root: "/some/worktree" });
        const unusable = PINNED_PORT_BASES.map((base) => shiftedPort(base, ports)).filter((port) => BLOCKED_PORTS.has(port) || port > 65_535);

        expect(unusable).toStrictEqual([]);
    });

    it("skips forward past offsets whose pair hits a blocked port", () => {
        expect.hasAssertions();

        // Offset 826 puts the studio on :6000 and 827 puts the playground there; both are browser-blocked.
        const rootFor = (target: number): string => {
            for (let index = 0; index < 1_000_000; index += 1) {
                const candidate = `/skip/${String(index)}`;

                if (hashPortOffset(candidate) === target) {
                    return candidate;
                }
            }

            throw new Error(`no root hashes to ${String(target)}`);
        };

        expect(derivePortOffset(rootFor(826))).toBe(828);
        expect(derivePortOffset(rootFor(827))).toBe(828);
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

        expect(resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "42" }, linked: true, root: "/worktree" })).toStrictEqual({
            offset: 42,
            playground: 5215,
            source: "env",
            studio: 5216,
        });
        expect(resolveDevPorts({ env: { CI: "1", LUNORA_DEV_PORT_OFFSET: "42" }, linked: false, root: "/main" }).playground).toBe(5215);
    });

    it("forces the legacy pair with LUNORA_DEV_PORT_OFFSET=0 even inside a linked worktree", () => {
        expect.hasAssertions();

        const ports = resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "0" }, linked: true, root: "/worktree" });

        expect([ports.playground, ports.studio, ports.source]).toStrictEqual([5173, 5174, "legacy"]);
    });

    it("rejects a malformed or browser-blocked explicit offset instead of drifting", () => {
        expect.hasAssertions();

        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "abc" }, linked: false, root: "/x" })).toThrow(/non-negative integer/u);
        // 827 + 5173 = 6000, a browser-blocked playground port.
        expect(() => resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "827" }, linked: false, root: "/x" })).toThrow(/browser-blocked/u);
    });

    it("describes the pair on one line", () => {
        expect.hasAssertions();

        const line = describeDevPorts(resolveDevPorts({ env: { LUNORA_DEV_PORT_OFFSET: "42" }, linked: false, root: "/x" }));

        expect(line).toBe("dev ports: playground :5215, studio :5216 (offset 42, env)");
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

    it("returns undefined outside any checkout", () => {
        expect.hasAssertions();

        const bare = tempRepo();

        expect(findCheckoutRoot(bare)).toBeUndefined();
    });
});
