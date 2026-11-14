import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    /** `defineQueue` exports under `lunora/`; an export `orders` is the queue `orders` on the binding `QUEUE_ORDERS`. */
    const declareQueues = (...names: string[]): void => {
        mkdirSync(join(projectRoot, "lunora"), { recursive: true });
        writeFileSync(
            join(projectRoot, "lunora", "queues.ts"),
            [`import { defineQueue } from "@lunora/queue";`, ...names.map((name) => `export const ${name} = defineQueue({ handler: async () => {} });`)].join(
                "\n",
            ),
        );
    };

    const producer = (queue: string): { binding: string; queue: string } => {
        return { binding: `QUEUE_${queue.toUpperCase()}`, queue };
    };

    /** The hints for the project, pointed at the Studio unless `urls` says otherwise. */
    const hints = (urls?: { environment?: string; scheduledUrl?: string; studioUrl?: string }) =>
        devTriggerHints({ projectRoot, schemaDirectory: "lunora", ...(urls ?? { studioUrl: STUDIO }) });

    it("points crons at the schedule page and a curl that fires the first one", () => {
        expect.assertions(1);

        writeWrangler({ triggers: { crons: ["*/5 * * * *", "0 0 * * *"] } });

        expect(hints({ scheduledUrl: SCHEDULED, studioUrl: STUDIO })).toStrictEqual([
            {
                label: "Crons",
                text: `2 scheduled → run one now in ${STUDIO}/schedule, or curl "${SCHEDULED}?cron=*%2F5+*+*+*+*"`,
            },
        ]);
    });

    it("reads the active environment's crons and queues, inheriting the top-level crons only", () => {
        expect.assertions(2);

        declareQueues("emails");
        writeWrangler({
            env: { staging: { queues: { producers: [producer("emails")] }, triggers: { crons: ["0 0 * * *"] } }, qa: {} },
            queues: { producers: [] },
            triggers: { crons: ["*/5 * * * *"] },
        });

        expect(hints({ environment: "staging", scheduledUrl: SCHEDULED, studioUrl: STUDIO })).toStrictEqual([
            { label: "Crons", text: `1 scheduled → run one now in ${STUDIO}/schedule, or curl "${SCHEDULED}?cron=0+0+*+*+*"` },
            { label: "Queues", text: `emails → send a test message in ${STUDIO}/queues` },
        ]);
        expect(hints({ environment: "qa", scheduledUrl: SCHEDULED, studioUrl: STUDIO })).toStrictEqual([
            { label: "Crons", text: `1 scheduled → run one now in ${STUDIO}/schedule, or curl "${SCHEDULED}?cron=*%2F5+*+*+*+*"` },
        ]);
    });

    it("names each declared queue the worker has a producer for, once", () => {
        expect.assertions(1);

        declareQueues("emails", "receipts");
        writeWrangler({
            queues: {
                consumers: [{ queue: "emails" }],
                producers: [producer("emails"), producer("receipts"), producer("receipts"), null],
            },
        });

        expect(hints()).toStrictEqual([{ label: "Queues", text: `emails, receipts → send a test message in ${STUDIO}/queues` }]);
    });

    it("leaves out a queue only wrangler.jsonc names, which the Studio has nothing to send from", () => {
        expect.assertions(2);

        declareQueues("emails");
        writeWrangler({ queues: { consumers: [{ queue: "jobs" }], producers: [producer("emails"), producer("audit")] } });

        expect(hints()).toStrictEqual([{ label: "Queues", text: `emails → send a test message in ${STUDIO}/queues` }]);

        writeWrangler({ queues: { producers: [producer("audit")] } });

        expect(hints()).toStrictEqual([]);
    });

    it("leaves out a declared queue the worker was not started with", () => {
        expect.assertions(1);

        declareQueues("emails");
        writeWrangler({ queues: { consumers: [{ queue: "emails" }] } });

        expect(hints()).toStrictEqual([]);
    });

    it("reads past a queue section of the wrong shape instead of throwing", () => {
        expect.assertions(2);

        declareQueues("jobs");
        writeWrangler({ queues: { consumers: [{ queue: "jobs" }, 7], producers: {} } });

        expect(hints()).toStrictEqual([]);

        writeWrangler({ queues: { producers: [7, producer("jobs")] } });

        expect(hints()).toStrictEqual([{ label: "Queues", text: `jobs → send a test message in ${STUDIO}/queues` }]);
    });

    it("summarizes queues past the third", () => {
        expect.assertions(1);

        const names = ["a", "b", "c", "d", "e"];

        declareQueues(...names);
        writeWrangler({ queues: { producers: names.map((name) => producer(name)) } });

        expect(hints()[0]?.text).toBe(`a, b, c +2 more → send a test message in ${STUDIO}/queues`);
    });

    it("prints nothing for a project with no crons or queues", () => {
        expect.assertions(1);

        writeWrangler({ triggers: { crons: [] } });

        expect(hints()).toStrictEqual([]);
    });

    it("prints nothing without a surface to point at", () => {
        expect.assertions(1);

        declareQueues("q");
        writeWrangler({ queues: { producers: [producer("q")] }, triggers: { crons: ["* * * * *"] } });

        expect(hints({})).toStrictEqual([]);
    });

    it("prints nothing when wrangler.jsonc is missing or unparseable", () => {
        expect.assertions(2);

        expect(hints()).toStrictEqual([]);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), "{ not json");

        expect(hints()).toStrictEqual([]);
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
