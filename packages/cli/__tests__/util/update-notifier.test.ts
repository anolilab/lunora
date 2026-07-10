import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import { compareVersions, formatUpdateNotice, isCacheFresh, isNewer, maybeNotifyUpdate } from "../../src/util/update-notifier";

const recordingLogger = (): { logger: Logger; warns: string[] } => {
    const warns: string[] = [];

    return { logger: { error: () => {}, info: () => {}, success: () => {}, warn: (m) => warns.push(m) }, warns };
};

const okFetch = (version: string) => async () => {
    return {
        json: async () => {
            return { version };
        },
        ok: true,
    };
};

describe("update-notifier helpers", () => {
    it("compareVersions orders by major.minor.patch and ignores prerelease", () => {
        expect.assertions(4);

        expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
        expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
        expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
        expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBe(0);
    });

    it("isNewer is true only for a strictly greater release", () => {
        expect.assertions(2);

        expect(isNewer("1.0.0", "1.0.1")).toBe(true);
        expect(isNewer("1.0.1", "1.0.0")).toBe(false);
    });

    it("isCacheFresh honours the TTL window", () => {
        expect.assertions(2);

        expect(isCacheFresh(1000, 1500, 1000)).toBe(true);
        expect(isCacheFresh(1000, 5000, 1000)).toBe(false);
    });

    it("formatUpdateNotice mentions both versions", () => {
        expect.assertions(1);

        expect(formatUpdateNotice("1.0.0", "2.0.0")).toContain("1.0.0 → 2.0.0");
    });
});

describe("maybeNotifyUpdate", () => {
    let cacheDir: string;
    const baseEnv = {} as NodeJS.ProcessEnv;

    beforeEach(() => {
        cacheDir = mkdtempSync(join(tmpdir(), "lunora-update-"));
    });

    afterEach(() => {
        rmSync(cacheDir, { force: true, recursive: true });
    });

    it("warns when a newer version is published, caching the result", async () => {
        expect.assertions(2);

        const { logger, warns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "1.0.0", env: baseEnv, fetchImpl: okFetch("2.0.0"), isTTY: true, logger, now: () => 1000 });

        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain("2.0.0");
    });

    it("stays silent for the unpublished dev version", async () => {
        expect.assertions(1);

        const { logger, warns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "0.0.0", env: baseEnv, fetchImpl: okFetch("2.0.0"), isTTY: true, logger });

        expect(warns).toHaveLength(0);
    });

    it("stays silent in CI and when not a TTY", async () => {
        expect.assertions(2);

        const { logger: ciLogger, warns: ciWarns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "1.0.0", env: { CI: "1" }, fetchImpl: okFetch("2.0.0"), isTTY: true, logger: ciLogger });

        expect(ciWarns).toHaveLength(0);

        const { logger: ttyLogger, warns: ttyWarns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "1.0.0", env: baseEnv, fetchImpl: okFetch("2.0.0"), isTTY: false, logger: ttyLogger });

        expect(ttyWarns).toHaveLength(0);
    });

    it("does not warn when already on the latest version", async () => {
        expect.assertions(1);

        const { logger, warns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "2.0.0", env: baseEnv, fetchImpl: okFetch("2.0.0"), isTTY: true, logger });

        expect(warns).toHaveLength(0);
    });

    it("defaults the cache under $XDG_CACHE_HOME/lunora, not the shared temp dir", async () => {
        expect.assertions(2);

        const xdgDir = mkdtempSync(join(tmpdir(), "lunora-xdg-"));
        const sharedTmpPath = join(tmpdir(), "lunora-cli-update.json");
        const tmpExistedBefore = existsSync(sharedTmpPath);

        try {
            const { logger } = recordingLogger();

            // No explicit cacheDir — the default must resolve to the user-owned XDG dir.
            await maybeNotifyUpdate({
                current: "1.0.0",
                env: { XDG_CACHE_HOME: xdgDir },
                fetchImpl: okFetch("2.0.0"),
                isTTY: true,
                logger,
                now: () => 1000,
            });

            expect(existsSync(join(xdgDir, "lunora", "lunora-cli-update.json"))).toBe(true);
            // The notifier must not have written the predictable shared-tmp path.
            expect(existsSync(sharedTmpPath) && !tmpExistedBefore).toBe(false);
        } finally {
            rmSync(xdgDir, { force: true, recursive: true });
        }
    });

    it("refuses to write through a pre-planted symlink (no clobber of the target)", async () => {
        expect.assertions(2);

        const sentinel = join(cacheDir, "victim.txt");

        writeFileSync(sentinel, "do-not-touch", "utf8");
        // Attacker pre-creates the cache path as a symlink to the victim file.
        symlinkSync(sentinel, join(cacheDir, "lunora-cli-update.json"));

        const { logger, warns } = recordingLogger();

        await maybeNotifyUpdate({ cacheDir, current: "1.0.0", env: baseEnv, fetchImpl: okFetch("2.0.0"), isTTY: true, logger, now: () => 1000 });

        // The symlink target must be untouched; the notice still fires off the fetched version.
        expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch");
        expect(warns).toHaveLength(1);
    });
});
