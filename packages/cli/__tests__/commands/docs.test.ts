import { describe, expect, test } from "vitest";

import { runDocsCommand } from "../../src/commands/docs.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

const recordingOpener = (): { openedUrls: string[]; opener: (url: string) => Promise<void> } => {
    const openedUrls: string[] = [];

    return {
        openedUrls,
        opener: async (url) => {
            openedUrls.push(url);
        },
    };
};

describe("cirrus docs", () => {
    test("opens the default docs URL when no section is given", async () => {
        expect.assertions(2);

        const { openedUrls, opener } = recordingOpener();

        const result = await runDocsCommand({ logger: silentLogger(), opener });

        expect(result.code).toBe(0);
        expect(openedUrls).toEqual(["https://cirrus.anolilab.dev/docs"]);
    });

    test("appends the section path", async () => {
        expect.assertions(1);

        const { openedUrls, opener } = recordingOpener();

        await runDocsCommand({ logger: silentLogger(), opener, section: "addons/dashboard" });

        expect(openedUrls).toEqual(["https://cirrus.anolilab.dev/docs/addons/dashboard"]);
    });

    test("normalises leading + trailing slashes", async () => {
        expect.assertions(1);

        const { openedUrls, opener } = recordingOpener();

        await runDocsCommand({ logger: silentLogger(), opener, section: "/migrating/from-convex/" });

        expect(openedUrls).toEqual(["https://cirrus.anolilab.dev/docs/migrating/from-convex"]);
    });

    test("reports opener failures", async () => {
        expect.assertions(2);

        const errors: string[] = [];

        const result = await runDocsCommand({
            logger: { ...silentLogger(), error: (msg) => errors.push(msg) },
            opener: async () => {
                throw new Error("xdg-open not found");
            },
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("failed to open");
    });
});
