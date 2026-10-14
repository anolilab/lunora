import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverQueueDeclarations, discoverQueues } from "../../src/discover/queues";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeQueues = (source: string): void => {
    writeFileSync(join(workdir, "queues.ts"), source);
};

describe("discover/queues", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-queue-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/queues.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverQueues(newProject(), workdir)).toEqual([]);
    });

    it("derives the binding + default queue name from the export name", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const emailQueue = defineQueue({ handler: async () => {} });
        `);

        expect(discoverQueues(newProject(), workdir)).toEqual([
            {
                bindingName: "QUEUE_EMAIL_QUEUE",
                exportName: "emailQueue",
                filePath: "queues",
                mode: "push",
                name: "email-queue",
                tuning: {},
            },
        ]);
    });

    it("honors an explicit non-empty name override", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const emailQueue = defineQueue({ name: "outbound", handler: async () => {} });
        `);

        expect(discoverQueues(newProject(), workdir)[0]?.name).toBe("outbound");
    });

    it("reads maxConcurrency with the other numeric tuning options", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const jobs = defineQueue({ maxBatchSize: 20, maxConcurrency: 4, handler: async () => {} });
        `);

        expect(discoverQueues(newProject(), workdir)[0]?.tuning).toStrictEqual({ maxBatchSize: 20, maxConcurrency: 4 });
    });

    it.each([
        ["maxConcurrency: 0", "`maxConcurrency` must be an integer from 1 to 250 (got 0)"],
        ["maxConcurrency: 251", "`maxConcurrency` must be an integer from 1 to 250 (got 251)"],
        ["maxBatchSize: 2.5", "`maxBatchSize` must be an integer from 1 to 100 (got 2.5)"],
        ["maxBatchTimeout: 61", "`maxBatchTimeout` must be a number from 0 to 60 (got 61)"],
    ])("rejects an out-of-range tuning value (%s)", (property, message) => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const jobs = defineQueue({ ${property}, handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(message);
    });

    it("rejects an empty static name, mirroring the runtime defineQueue guard", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const emailQueue = defineQueue({ name: "", handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/`name` must be a non-empty string/u);
    });

    it("rejects two queues that deploy under the same name", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const first = defineQueue({ name: "shared", handler: async () => {} });
            export const second = defineQueue({ name: "shared", mode: "pull" });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/Duplicate queue name "shared"/u);
    });

    it("rejects two queue exports that collapse to the same binding name", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineQueue } from "@lunora/queue";

            export const myQueue = defineQueue({ name: "one", handler: async () => {} });
            export const myQUEUE = defineQueue({ name: "two", handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/Duplicate queue binding "QUEUE_MY_QUEUE"/u);
    });

    it("discovers topics and lifts each subscription into a push queue carrying its topic", () => {
        expect.assertions(2);

        writeQueues(`
            import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";

            export const signups = defineTopic<{ userId: string }>();
            export const orders = defineTopic();

            export const welcome = defineSubscription(signups, { handler: async () => {}, maxRetries: 5, deadLetterQueue: "welcome-dlq" });
            export const audit = defineSubscription(signups, { name: "signup-audit", handler: async () => {} });
            export const emailQueue = defineQueue({ handler: async () => {} });
        `);

        expect(discoverQueues(newProject(), workdir)).toEqual([
            { bindingName: "QUEUE_AUDIT", exportName: "audit", filePath: "queues", mode: "push", name: "signup-audit", topic: "signups", tuning: {} },
            { bindingName: "QUEUE_EMAIL_QUEUE", exportName: "emailQueue", filePath: "queues", mode: "push", name: "email-queue", tuning: {} },
            {
                bindingName: "QUEUE_WELCOME",
                exportName: "welcome",
                filePath: "queues",
                mode: "push",
                name: "welcome",
                topic: "signups",
                tuning: { deadLetterQueue: "welcome-dlq", maxRetries: 5 },
            },
        ]);
        expect(discoverQueueDeclarations(newProject(), workdir).topics).toEqual([
            { exportName: "orders", filePath: "queues" },
            { exportName: "signups", filePath: "queues" },
        ]);
    });

    it("rejects a subscription whose topic is not a defineTopic export of the file", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineSubscription } from "@lunora/queue";
            import { signups } from "./elsewhere";

            export const welcome = defineSubscription(signups, { handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/must name a `defineTopic\(\)` export/u);
    });

    it("rejects `mode` on a subscription", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineSubscription, defineTopic } from "@lunora/queue";

            export const signups = defineTopic();
            export const welcome = defineSubscription(signups, { mode: "pull", handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/always a push consumer/u);
    });

    it("returns no queues or topics when lunora/queues.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverQueueDeclarations(newProject(), workdir)).toEqual({ queues: [], topics: [] });
    });

    it("rejects two subscriptions that deploy under the same name, across topics", () => {
        expect.assertions(1);

        writeQueues(`
            import { defineSubscription, defineTopic } from "@lunora/queue";

            export const signups = defineTopic();
            export const orders = defineTopic();
            export const a = defineSubscription(signups, { name: "audit", handler: async () => {} });
            export const b = defineSubscription(orders, { name: "audit", handler: async () => {} });
        `);

        expect(() => discoverQueues(newProject(), workdir)).toThrow(/Duplicate queue name "audit"/u);
    });

    it("follows an aliased defineTopic / defineSubscription import", () => {
        expect.assertions(2);

        writeQueues(`
            import { defineSubscription as subscribe, defineTopic as topic } from "@lunora/queue";

            export const signups = topic();
            export const welcome = subscribe(signups, { handler: async () => {} });
        `);

        const { queues, topics } = discoverQueueDeclarations(newProject(), workdir);

        expect(topics).toEqual([{ exportName: "signups", filePath: "queues" }]);
        expect(queues[0]?.topic).toBe("signups");
    });

    describe("module queues.ts", () => {
        const writeModule = (name: string, queuesSource: string): void => {
            mkdirSync(join(workdir, name), { recursive: true });
            writeFileSync(join(workdir, name, "module.ts"), `import { defineModule } from "@lunora/server";\n\nexport default defineModule({});\n`);
            writeFileSync(join(workdir, name, "queues.ts"), queuesSource);
        };

        it("discovers a module's queues and topics with their declaring file, without a root queues.ts", () => {
            expect.assertions(2);

            writeModule(
                "billing",
                `
                import { defineQueue, defineTopic } from "@lunora/queue";

                export const invoices = defineQueue({ handler: async () => {} });
                export const paid = defineTopic();
            `,
            );

            const { queues, topics } = discoverQueueDeclarations(newProject(), workdir);

            expect(queues).toEqual([
                { bindingName: "QUEUE_INVOICES", exportName: "invoices", filePath: "billing/queues", mode: "push", name: "invoices", tuning: {} },
            ]);
            expect(topics).toEqual([{ exportName: "paid", filePath: "billing/queues" }]);
        });

        it("ignores a queues.ts in a folder that is not a module", () => {
            expect.assertions(1);

            mkdirSync(join(workdir, "misc"));
            writeFileSync(
                join(workdir, "misc", "queues.ts"),
                `import { defineQueue } from "@lunora/queue";\n\nexport const stray = defineQueue({ handler: async () => {} });\n`,
            );

            expect(discoverQueues(newProject(), workdir)).toEqual([]);
        });

        it("lets a module subscribe to a topic lunora/queues.ts declares", () => {
            expect.assertions(1);

            writeQueues(`
                import { defineTopic } from "@lunora/queue";

                export const signups = defineTopic();
            `);
            writeModule(
                "billing",
                `
                import { defineSubscription } from "@lunora/queue";
                import { signups } from "../queues";

                export const openAccount = defineSubscription(signups, { handler: async () => {} });
            `,
            );

            expect(discoverQueues(newProject(), workdir)).toEqual([
                expect.objectContaining({ exportName: "openAccount", filePath: "billing/queues", topic: "signups" }),
            ]);
        });

        it("rejects an export name two queues files share, pointing at the second", () => {
            expect.assertions(1);

            writeQueues(`
                import { defineQueue } from "@lunora/queue";

                export const invoices = defineQueue({ handler: async () => {} });
            `);
            writeModule(
                "billing",
                `
                import { defineQueue } from "@lunora/queue";

                export const invoices = defineQueue({ name: "billing-invoices", handler: async () => {} });
            `,
            );

            expect(() => discoverQueues(newProject(), workdir)).toThrow(
                /"invoices" is exported by both lunora\/queues\.ts and lunora\/billing\/queues\.ts .*billing\/queues\.ts:4:\d+\)/u,
            );
        });
    });
});
