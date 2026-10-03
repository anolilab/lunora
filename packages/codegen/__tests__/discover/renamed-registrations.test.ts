import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project, ts } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../../src/discover/agents";
import { discoverContainers } from "../../src/discover/containers";
import { discoverEnv } from "../../src/discover/env";
import discoverFunctions from "../../src/discover/functions";
import { discoverIdentity } from "../../src/discover/identity";
import discoverKvKeyAccesses from "../../src/discover/kv-key-accesses";
import discoverMigrations from "../../src/discover/migrations";
import { discoverQueueDeclarations, discoverQueues } from "../../src/discover/queues";
import { discoverShapes } from "../../src/discover/shapes";
import { discoverWorkflows } from "../../src/discover/workflows";
import { runCodegen } from "../../src/index";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const write = (file: string, source: string): void => {
    writeFileSync(join(workdir, file), source);
};

// A binding exported only by `export { local as exported }` registers as
// `exported`, and one exported only under a string name that is not an
// identifier does not register at all (`procedure_not_registered` names it).
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

    it("names a site by the identifier export when a string-literal alias sits beside it", () => {
        expect.assertions(2);

        // `kebab-name` sorts first by code point, but only `start` is addressable,
        // so registration and every lint row name the function `start`.
        write(
            "other.ts",
            `import { query } from "@lunora/server";\nconst run = query(async ({ ctx, args }) => ctx.kv.get(args.key));\nexport { run as start, run as "kebab-name" };\n`,
        );

        expect(discoverFunctions(newProject(), workdir).map((entry) => entry.exportName)).toEqual(["start"]);
        expect(discoverKvKeyAccesses(newProject(), workdir)).toMatchObject([{ scope: { kind: "export", name: "start" } }]);
    });
});

/** One registration kind: its module, its define call, and how to read the discovered names. */
interface Kind {
    call: string;
    discover: (project: Project, directory: string) => ReadonlyArray<string>;
    file: string;
    importLine: string;
    kind: string;
    /** `"binding"` kinds cannot be named `default` or a reserved word; `"member"` kinds are read off the namespace. */
    use: "binding" | "member";
}

const KINDS: ReadonlyArray<Kind> = [
    {
        call: "defineWorkflow({ handler: async () => undefined })",
        discover: (project, directory) => discoverWorkflows(project, directory).map((entry) => entry.exportName),
        file: "workflows.ts",
        importLine: 'import { defineWorkflow } from "@lunora/workflow";',
        kind: "workflow",
        use: "binding",
    },
    {
        call: 'defineContainer({ image: "./containers/transcoder" })',
        discover: (project, directory) => discoverContainers(project, directory).map((entry) => entry.exportName),
        file: "containers.ts",
        importLine: 'import { defineContainer } from "@lunora/container";',
        kind: "container",
        use: "binding",
    },
    {
        call: 'defineAgent({ model: "m" })',
        discover: (project, directory) => discoverAgents(project, directory).map((entry) => entry.exportName),
        file: "agents.ts",
        importLine: 'import { defineAgent } from "@lunora/agent";',
        kind: "agent",
        use: "binding",
    },
    {
        call: "defineQueue({ handler: async () => {} })",
        discover: (project, directory) => discoverQueues(project, directory).map((entry) => entry.exportName),
        file: "queues.ts",
        importLine: 'import { defineQueue } from "@lunora/queue";',
        kind: "queue",
        use: "binding",
    },
    {
        call: 'defineShape({ table: "messages", where: () => ({}) })',
        discover: (project, directory) => discoverShapes(project, directory).map((entry) => entry.exportName),
        file: "shapes.ts",
        importLine: 'import { defineShape } from "@lunora/server";',
        kind: "shape",
        use: "binding",
    },
    {
        call: 'defineMigration({ id: "backfill", table: "messages", up: (document) => document })',
        discover: (project, directory) => discoverMigrations(project, directory).map((entry) => entry.exportName),
        file: "migrations.ts",
        importLine: 'import { defineMigration } from "@lunora/server";',
        kind: "migration",
        use: "member",
    },
    {
        call: "defineIdentity({ userId: v.string() })",
        discover: (project, directory) => [discoverIdentity(project, directory)?.exportName].filter((name): name is string => name !== undefined),
        file: "identity.ts",
        importLine: 'import { defineIdentity, v } from "@lunora/server";',
        kind: "identity",
        use: "member",
    },
    {
        call: "defineEnv({ API_KEY: v.string() })",
        discover: (project, directory) => [discoverEnv(project, directory)?.exportName].filter((name): name is string => name !== undefined),
        file: "env.ts",
        importLine: 'import { defineEnv, v } from "@lunora/server";',
        kind: "env",
        use: "member",
    },
];

/** Syntax errors in a generated module: what an invalid binding (`import { default }`) produces. */
const syntaxErrorsOf = (text: string): string[] => {
    const file = ts.createSourceFile("generated.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    return (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
};

// A registration that is not a procedure keeps the name a class, binding or
// deployed resource is derived from: the `export` keyword's own name wins over
// any alias, so adding an alias never renames a deployed workflow or queue.
describe.each(KINDS)("$kind exports", ({ call, discover, file, importLine, use }) => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-renamed-kind-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("keeps the keyword name when an alias is added", () => {
        expect.assertions(1);

        write(file, `${importLine}\nexport const zeta = ${call};\nexport { zeta as alpha };\n`);

        expect(discover(newProject(), workdir)).toStrictEqual(["zeta"]);
    });

    it("keeps the keyword name beside `export default`", () => {
        expect.assertions(1);

        write(file, `${importLine}\nexport const zeta = ${call};\nexport default zeta;\n`);

        expect(discover(newProject(), workdir)).toStrictEqual(["zeta"]);
    });

    it("registers a pure rename under its alias", () => {
        expect.assertions(1);

        write(file, `${importLine}\nconst zeta = ${call};\nexport { zeta as alpha };\n`);

        expect(discover(newProject(), workdir)).toStrictEqual(["alpha"]);
    });

    it(`${use === "binding" ? "does not register" : "registers"} a binding exported only under a reserved name`, () => {
        expect.assertions(2);

        write(file, `${importLine}\nconst zeta = ${call};\nexport { zeta as delete };\n`);

        expect(discover(newProject(), workdir)).toStrictEqual(use === "binding" ? [] : ["delete"]);

        write(file, `${importLine}\nconst zeta = ${call};\nexport default zeta;\n`);

        expect(discover(newProject(), workdir)).toStrictEqual(use === "binding" ? [] : ["default"]);
    });
});

describe("emitted output for registrations exported as `default` or a reserved word", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-renamed-emit-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it.each(["export default zeta;", "export { zeta as delete };", "export const alias = zeta;\nexport { zeta as default };"])(
        "keeps every generated module parseable for `%s`",
        (exportStatement) => {
            expect.assertions(2);

            const lunora = join(workdir, "lunora");

            mkdirSync(lunora, { recursive: true });
            writeFileSync(
                join(lunora, "schema.ts"),
                `import { defineSchema, defineTable, v } from "@lunora/server";\nexport default defineSchema({ messages: defineTable({ text: v.string() }) });\n`,
            );

            for (const { call, file, importLine } of KINDS) {
                writeFileSync(join(lunora, file), `${importLine}\nconst zeta = ${call};\n${exportStatement}\n`);
            }

            const { generated } = runCodegen({ lint: false, projectRoot: workdir });

            const modules = Object.entries(generated).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].endsWith("Json") && !entry[0].startsWith("open"),
            );
            const errors = modules.flatMap(([name, text]) => syntaxErrorsOf(text).map((message) => `${name}: ${message}`));

            expect(modules.length).toBeGreaterThan(0);
            expect(errors).toStrictEqual([]);
        },
    );
});
