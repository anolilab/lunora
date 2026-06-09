import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runViewCommand } from "../../src/commands/view";
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

describe("cirrus view", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-view-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus view", () => {
        it("defaults to localhost:8787/_cirrus/studio", async () => {
            expect.assertions(2);

            const { logger } = recordingLogger();
            const { openedUrls, opener } = recordingOpener();

            const result = await runViewCommand({ cwd: workdir, logger, opener });

            expect(result.code).toBe(0);
            expect(openedUrls).toEqual(["http://localhost:8787/_cirrus/studio"]);
        });

        it("honours wrangler.dev.port for the local studio", async () => {
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

            expect(openedUrls).toEqual(["http://localhost:9091/_cirrus/studio"]);
        });

        it("--remote builds a URL from wrangler.routes when present", async () => {
            expect.assertions(1);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "demo",
    "compatibility_date": "2026-04-07",
    "routes": [{ "pattern": "api.example.com/*", "zone_name": "example.com" }]
}`,
                "utf8",
            );
            const { logger } = recordingLogger();
            const { openedUrls, opener } = recordingOpener();

            await runViewCommand({ cwd: workdir, logger, opener, remote: true });

            expect(openedUrls).toEqual(["https://api.example.com/_cirrus/studio"]);
        });

        it("--remote falls back to <name>.workers.dev when no routes are set", async () => {
            expect.assertions(1);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "my-worker",
    "compatibility_date": "2026-04-07"
}`,
                "utf8",
            );
            const { logger } = recordingLogger();
            const { openedUrls, opener } = recordingOpener();

            await runViewCommand({ cwd: workdir, logger, opener, remote: true });

            expect(openedUrls).toEqual(["https://my-worker.workers.dev/_cirrus/studio"]);
        });

        it("--remote without wrangler returns 1", async () => {
            expect.assertions(3);

            const { logger, recorded } = recordingLogger();
            const { openedUrls, opener } = recordingOpener();

            const result = await runViewCommand({ cwd: workdir, logger, opener, remote: true });

            expect(result.code).toBe(1);
            expect(openedUrls).toEqual([]);
            expect(recorded.errors.join("\n")).toContain("could not determine the remote URL");
        });
    });
});
