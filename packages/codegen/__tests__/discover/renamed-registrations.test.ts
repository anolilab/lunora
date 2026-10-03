import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../../src/discover/agents";
import { discoverContainers } from "../../src/discover/containers";
import discoverMigrations from "../../src/discover/migrations";
import { discoverQueueDeclarations, discoverQueues } from "../../src/discover/queues";
import { discoverShapes } from "../../src/discover/shapes";
import { discoverWorkflows } from "../../src/discover/workflows";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const write = (file: string, source: string): void => {
    writeFileSync(join(workdir, file), source);
};

// Every registration kind is addressed by the name its module EXPORTS: the
// emitted imports and registries read it off the module namespace. A binding
// exported only by `export { local as exported }` registers as `exported`, and
// one exported only under a string name that is not an identifier does not
// register at all (`procedure_not_registered` names it).
describe("registrations exported by a separate specifier", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-renamed-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("registers a shape under its exported name", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";\nconst room = defineShape({ table: "messages", where: () => ({}) });\nexport { room as chatRoom };\n`,
        );

        expect(discoverShapes(newProject(), workdir).map((shape) => shape.exportName)).toEqual(["chatRoom"]);
    });

    it("registers a workflow under its exported name", () => {
        expect.assertions(1);

        write(
            "workflows.ts",
            `import { defineWorkflow } from "@lunora/workflow";\nconst pipeline = defineWorkflow({ handler: async () => undefined });\nexport { pipeline as orderPipeline };\n`,
        );

        expect(discoverWorkflows(newProject(), workdir).map((workflow) => [workflow.exportName, workflow.className])).toEqual([
            ["orderPipeline", "OrderPipelineWorkflow"],
        ]);
    });

    it("registers a queue, a topic and its subscription under their exported names", () => {
        expect.assertions(2);

        write(
            "queues.ts",
            `import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";
const mail = defineQueue({ handler: async () => {} });
const events = defineTopic();
const audit = defineSubscription(events, { handler: async () => {} });
export { mail as emailQueue, events as orderEvents, audit as auditTrail };
`,
        );

        expect(discoverQueues(newProject(), workdir).map((queue) => [queue.exportName, queue.topic])).toEqual([
            ["auditTrail", "orderEvents"],
            ["emailQueue", undefined],
        ]);
        expect(discoverQueueDeclarations(newProject(), workdir).topics.map((topic) => topic.exportName)).toEqual(["orderEvents"]);
    });

    it("registers an agent under its exported name", () => {
        expect.assertions(1);

        write("agents.ts", `import { defineAgent } from "@lunora/agent";\nconst helper = defineAgent({ model: "m" });\nexport { helper as support };\n`);

        expect(discoverAgents(newProject(), workdir).map((agent) => agent.exportName)).toEqual(["support"]);
    });

    it("registers a container under its exported name", () => {
        expect.assertions(1);

        write(
            "containers.ts",
            `import { defineContainer } from "@lunora/container";\nconst worker = defineContainer({ image: "./containers/transcoder" });\nexport { worker as transcoder };\n`,
        );

        expect(discoverContainers(newProject(), workdir).map((container) => container.exportName)).toEqual(["transcoder"]);
    });

    it("registers a migration under its exported name", () => {
        expect.assertions(1);

        write(
            "migrations.ts",
            `import { defineMigration } from "@lunora/server";\nconst fill = defineMigration({ id: "backfill-read-by", table: "messages", up: (document) => document });\nexport { fill as backfill };\n`,
        );

        expect(discoverMigrations(newProject(), workdir).map((migration) => migration.exportName)).toEqual(["backfill"]);
    });

    it("does not register a shape exported only under a string name that is not an identifier", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";\nconst room = defineShape({ table: "messages", where: () => ({}) });\nexport { room as "chat-room" };\n`,
        );

        expect(discoverShapes(newProject(), workdir)).toEqual([]);
    });
});
