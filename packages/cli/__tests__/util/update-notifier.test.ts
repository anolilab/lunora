import { mkdtempSync, rmSync } from "node:fs";
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
});
