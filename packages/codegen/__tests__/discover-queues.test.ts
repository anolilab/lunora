import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverQueues } from "../src/discover-queues";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeQueues = (source: string): void => {
    writeFileSync(join(workdir, "queues.ts"), source);
};

describe("discover-queues", () => {
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
});
