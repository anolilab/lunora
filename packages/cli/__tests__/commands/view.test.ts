import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runViewCommand } from "../../src/commands/view/handler";
import type { Logger } from "../../src/util/logger";

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

const recordingOpener = (): { openedUrls: string[]; opener: (url: string) => Promise<void> } => {
    const openedUrls: string[] = [];

    return {
        openedUrls,
        opener: async (url) => {
            openedUrls.push(url);
        },
    };
};

let workdir: string;

/** Write a `.lunora/dev.json` record for a live (this process's) dev server. */
const recordDevServer = (state: Record<string, unknown>): void => {
    mkdirSync(join(workdir, ".lunora"), { recursive: true });
    writeFileSync(join(workdir, ".lunora", "dev.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...state }), "utf8");
};

describe("lunora view", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-view-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("defaults to the local studio server when no dev server is running", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const { openedUrls, opener } = recordingOpener();

        const result = await runViewCommand({ cwd: workdir, logger, opener });

        expect(result.code).toBe(0);
        expect(openedUrls).toEqual(["http://127.0.0.1:6173"]);
    });

    it("opens the running dev server's recorded studioUrl", async () => {
        expect.assertions(1);

        recordDevServer({ mode: "cli", studioUrl: "http://127.0.0.1:6180", url: "http://localhost:8788" });

        const { logger } = recordingLogger();
        const { openedUrls, opener } = recordingOpener();

        await runViewCommand({ cwd: workdir, logger, opener });

        expect(openedUrls).toEqual(["http://127.0.0.1:6180"]);
    });

    it("opens the Vite dev server's /__lunora route when Vite owns the studio", async () => {
        expect.assertions(1);

        recordDevServer({ mode: "vite", url: "http://localhost:5174/" });

        const { logger } = recordingLogger();
        const { openedUrls, opener } = recordingOpener();

        await runViewCommand({ cwd: workdir, logger, opener });

        expect(openedUrls).toEqual(["http://localhost:5174/__lunora"]);
    });

    it("ignores a wrangler dev.port — the worker serves no studio", async () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
    "name": "demo",
    "compatibility_date": "2026-04-07",
    "dev": { "port": 9091 }
}`,
            "utf8",
        );

        const { logger } = recordingLogger();
        const { openedUrls, opener } = recordingOpener();

        await runViewCommand({ cwd: workdir, logger, opener });

        expect(openedUrls).toEqual(["http://127.0.0.1:6173"]);
    });

    it("returns 1 when the opener fails", async () => {
        expect.assertions(2);

        const { logger, recorded } = recordingLogger();

        const result = await runViewCommand({
            cwd: workdir,
            logger,
            opener: async () => {
                throw new Error("no browser");
            },
        });

        expect(result.code).toBe(1);
        expect(recorded.errors.join("\n")).toContain("failed to open URL: no browser");
    });
});
