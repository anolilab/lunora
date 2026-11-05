import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devTriggerHints, formatDevBannerRow } from "../src/dev-trigger-hints";

const ORIGIN = "http://localhost:5173";
const STUDIO = `${ORIGIN}/__lunora`;
const SCHEDULED = `${ORIGIN}/cdn-cgi/local/scheduled`;

describe(devTriggerHints, () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-dev-trigger-hints-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    const writeWrangler = (config: Record<string, unknown>): void => {
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `// comment\n${JSON.stringify({ name: "app", ...config })}`);
    };

    it("points crons at the schedule page and a curl that fires the first one", () => {
        expect.assertions(1);

        writeWrangler({ triggers: { crons: ["*/5 * * * *", "0 0 * * *"] } });

        expect(devTriggerHints({ projectRoot, scheduledUrl: SCHEDULED, studioUrl: STUDIO })).toStrictEqual([
            {
                label: "Crons",
                text: `2 scheduled → run one now in ${STUDIO}/schedule, or curl "${SCHEDULED}?cron=*%2F5+*+*+*+*"`,
            },
        ]);
    });

    it("names each queue once across producers and consumers", () => {
        expect.assertions(1);

        writeWrangler({
            queues: {
                consumers: [{ queue: "emails" }, { queue: "jobs" }],
                producers: [{ binding: "EMAILS", queue: "emails" }, { binding: "RECEIPTS", queue: "receipts" }, null],
            },
        });

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })).toStrictEqual([
            { label: "Queues", text: `emails, receipts, jobs → send a test message in ${STUDIO}/queues` },
        ]);
    });

    it("reads past a queue section of the wrong shape instead of throwing", () => {
        expect.assertions(1);

        writeWrangler({ queues: { consumers: [{ queue: "jobs" }, 7], producers: {} } });

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })).toStrictEqual([
            { label: "Queues", text: `jobs → send a test message in ${STUDIO}/queues` },
        ]);
    });

    it("summarizes queues past the third", () => {
        expect.assertions(1);

        writeWrangler({
            queues: {
                producers: ["a", "b", "c", "d", "e"].map((queue) => {
                    return { binding: queue.toUpperCase(), queue };
                }),
            },
        });

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })[0]?.text).toBe(`a, b, c +2 more → send a test message in ${STUDIO}/queues`);
    });

    it("prints nothing for a project with no crons or queues", () => {
        expect.assertions(1);

        writeWrangler({ triggers: { crons: [] } });

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })).toStrictEqual([]);
    });

    it("prints nothing without a surface to point at", () => {
        expect.assertions(1);

        writeWrangler({ queues: { producers: [{ binding: "Q", queue: "q" }] }, triggers: { crons: ["* * * * *"] } });

        expect(devTriggerHints({ projectRoot })).toStrictEqual([]);
    });

    it("prints nothing when wrangler.jsonc is missing or unparseable", () => {
        expect.assertions(2);

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })).toStrictEqual([]);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), "{ not json");

        expect(devTriggerHints({ projectRoot, studioUrl: STUDIO })).toStrictEqual([]);
    });
});

describe(formatDevBannerRow, () => {
    it("pads the label column so values line up", () => {
        expect.assertions(2);

        expect(formatDevBannerRow("Crons", "1 scheduled", 12)).toBe("  ➜  Crons:      1 scheduled");
        expect(formatDevBannerRow("Queues", "emails", 12)).toBe("  ➜  Queues:     emails");
    });

    it("styles the arrow and label after padding, so escape codes never count toward the width", () => {
        expect.assertions(1);

        const bold = (text: string): string => `<b>${text}</b>`;

        expect(formatDevBannerRow("Lunora", "url", 9, { arrow: bold, label: bold })).toBe("  <b>➜</b>  <b>Lunora</b>:  url");
    });

    it("gives a label wider than the column no padding instead of throwing", () => {
        expect.assertions(1);

        expect(formatDevBannerRow("Workflows", "3", 9)).toBe("  ➜  Workflows:3");
    });
});
