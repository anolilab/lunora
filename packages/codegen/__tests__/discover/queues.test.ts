import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
            { bindingName: "QUEUE_AUDIT", exportName: "audit", mode: "push", name: "signup-audit", topic: "signups", tuning: {} },
            { bindingName: "QUEUE_EMAIL_QUEUE", exportName: "emailQueue", mode: "push", name: "email-queue", tuning: {} },
            {
                bindingName: "QUEUE_WELCOME",
                exportName: "welcome",
                mode: "push",
                name: "welcome",
                topic: "signups",
                tuning: { deadLetterQueue: "welcome-dlq", maxRetries: 5 },
            },
        ]);
        expect(discoverQueueDeclarations(newProject(), workdir).topics).toEqual([{ exportName: "orders" }, { exportName: "signups" }]);
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

        expect(topics).toEqual([{ exportName: "signups" }]);
        expect(queues[0]?.topic).toBe("signups");
    });
});
