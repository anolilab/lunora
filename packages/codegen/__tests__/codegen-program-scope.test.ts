import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodegenProject, listLunoraSourceFiles, refreshCodegenProject, runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;
let lunoraDirectory: string;

const loaded = (project: Project, path: string): boolean => project.getSourceFile(path) !== undefined;

const writeConfig = (source: string): void => {
    writeFileSync(join(workdir, "lunora.config.ts"), source, "utf8");
};

/**
 * Which files the TypeScript program codegen resolves types over starts from. The
 * tsconfig below includes a whole `src/` (a React component, an ambient declaration)
 * next to `lunora/`; the default program loads the declaration and not the component.
 */
describe("codegen program seeding", () => {
    let componentPath: string;
    let ambientPath: string;
    let validatorsPath: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-scope-"));
        lunoraDirectory = join(workdir, "lunora");
        componentPath = join(workdir, "src", "app.tsx");
        ambientPath = join(workdir, "src", "env.d.ts");
        validatorsPath = join(workdir, "src", "validators.ts");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });
        mkdirSync(join(workdir, "src"), { recursive: true });

        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({
                compilerOptions: { jsx: "react-jsx", module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" },
                include: ["src/**/*", "lunora/**/*"],
            }),
            "utf8",
        );
        writeFileSync(componentPath, "export const App = () => null;\n", "utf8");
        writeFileSync(ambientPath, "interface LunoraAmbientMarker { marker: true }\n", "utf8");
        writeFileSync(validatorsPath, `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string() });\n`, "utf8");
        writeFileSync(
            join(lunoraDirectory, "listItems.ts"),
            `import { query } from "@lunora/server";

import { itemValidator } from "../src/validators";

export const listItems = query({
    args: { item: itemValidator },
    handler: async (_context, args) => args.item,
});
`,
            "utf8",
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("builds the program from lunora/ and the tsconfig's ambient declarations by default, not from the whole tsconfig", () => {
        expect.assertions(4);

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, join(lunoraDirectory, "schema.ts"))).toBe(true);
        expect(loaded(project, ambientPath)).toBe(true);
        expect(loaded(project, componentPath)).toBe(false);
        // Reached by import, not by seeding: the shared validator still resolves.
        expect(runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] }).generated.functions).toContain("title: string");
    });

    it("warns about an unreadable `exclude` and seeds the program as if it were absent", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        writeConfig(`export default { codegen: { exclude: ["!seed/**"] } };\n`);

        expect(loaded(createCodegenProject(lunoraDirectory), componentPath)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("codegen.exclude"));
    });

    it("follows a file a lunora/ source starts importing mid-session, so a later edit to it is not served stale", () => {
        expect.assertions(2);

        const listItems = join(lunoraDirectory, "listItems.ts");
        const withImport = readFileSync(listItems, "utf8");

        writeFileSync(
            listItems,
            withImport.replace(`import { itemValidator } from "../src/validators";\n`, "").replace("args: { item: itemValidator }", "args: {}"),
            "utf8",
        );

        const project = createCodegenProject(lunoraDirectory);

        runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });

        // `src/validators.ts` was not imported when the Project was built. Importing
        // it now reaches it through resolution only; nothing in the Project knows it.
        writeFileSync(listItems, withImport, "utf8");
        refreshCodegenProject(project, lunoraDirectory);
        runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });

        writeFileSync(
            validatorsPath,
            `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string(), age: v.number() });\n`,
            "utf8",
        );
        refreshCodegenProject(project, lunoraDirectory);

        const reused = runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });
        const fresh = runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(reused.generated.functions).toContain("age: number");
        expect(reused.generated.functions).toBe(fresh.generated.functions);
    });

    it("holds every file a run reads, so none is added once the program exists", () => {
        expect.assertions(1);

        // First run writes `_generated/`; the second starts from a fresh Project over a
        // tree that already has it, which is the steady state of every later run.
        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        writeConfig(`export default { target: "cloudflare" };\n`);
        mkdirSync(join(workdir, "src", "server"), { recursive: true });
        writeFileSync(join(workdir, "src", "server", "index.ts"), "export default { fetch: () => new Response() };\n", "utf8");
        writeFileSync(join(workdir, "vite.config.ts"), "export default { plugins: [] };\n", "utf8");

        const project = createCodegenProject(lunoraDirectory);
        const seeded = new Set(project.getSourceFiles().map((file) => file.getFilePath()));

        runCodegen({ dryRun: true, lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });

        // A file added after the program is built throws the program and its type
        // checker away, which is most of what a run costs.
        expect(
            project
                .getSourceFiles()
                .map((file) => file.getFilePath())
                .filter((path) => !seeded.has(path)),
        ).toStrictEqual([]);
    });

    it("does not crash on a tsconfig `files` entry for a declaration that is not on disk yet", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { strict: true }, files: ["worker-configuration.d.ts"], include: ["lunora/**/*"] }),
            "utf8",
        );

        expect(() => createCodegenProject(lunoraDirectory)).not.toThrow();
    });

    it("loads `.d.mts` and `.d.cts` declarations the tsconfig includes", () => {
        expect.assertions(2);

        const modulePath = join(workdir, "src", "globals.d.mts");
        const commonPath = join(workdir, "src", "legacy.d.cts");

        writeFileSync(modulePath, "export {};\n", "utf8");
        writeFileSync(commonPath, "export {};\n", "utf8");
        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*", "lunora/**/*"] }), "utf8");

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, modulePath)).toBe(true);
        expect(loaded(project, commonPath)).toBe(true);
    });

    it("keeps a nested `_generated/` file (a lazy function module, a service declaration) through a warm refresh", () => {
        expect.assertions(2);

        const nestedPath = join(lunoraDirectory, "_generated", "fn", "shim.ts");

        mkdirSync(join(lunoraDirectory, "_generated", "fn"), { recursive: true });
        writeFileSync(nestedPath, "export const shim = 1;\n", "utf8");

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, nestedPath)).toBe(true);

        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, nestedPath)).toBe(true);
    });

    it("re-reads a tsconfig file that became a same-size script with its mtime kept", () => {
        expect.assertions(2);

        const sourcePath = join(workdir, "src", "shared.ts");
        const moduleText = "export const marker = 1; // padded to the length of the script that replaces it\n";
        const scriptText = `${"declare var __MARKER__: string;".padEnd(moduleText.length - 1)}\n`;

        // A fixed mtime on both writes, so the two versions share it exactly.
        const fixedMtime = new Date("2020-01-01T00:00:00.000Z");

        writeFileSync(sourcePath, moduleText, "utf8");
        utimesSync(sourcePath, fixedMtime, fixedMtime);

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, sourcePath)).toBe(false);

        // Same size and same mtime: only the content has changed.
        writeFileSync(sourcePath, scriptText, "utf8");
        utimesSync(sourcePath, fixedMtime, fixedMtime);
        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, sourcePath)).toBe(true);
    });

    it("ignores a directory named like a `_generated/` file instead of crashing on it", () => {
        expect.assertions(2);

        mkdirSync(join(lunoraDirectory, "_generated", "archive.ts"), { recursive: true });

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, join(lunoraDirectory, "_generated", "archive.ts"))).toBe(false);
        expect(() => {
            refreshCodegenProject(project, lunoraDirectory);
        }).not.toThrow();
    });

    it("keeps the `_generated/` files a cold start seeded through a warm refresh", () => {
        expect.assertions(1);

        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        const generatedPath = join(lunoraDirectory, "_generated", "api.ts");
        const project = createCodegenProject(lunoraDirectory);

        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, generatedPath)).toBe(true);
    });

    it("adds a tsconfig declaration generated after the Project was built, on the next refresh", () => {
        expect.assertions(2);

        const generatedDeclaration = join(workdir, "worker-configuration.d.ts");

        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { strict: true }, files: ["worker-configuration.d.ts"], include: ["lunora/**/*"] }),
            "utf8",
        );

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, generatedDeclaration)).toBe(false);

        // `wrangler types` writes the file while a dev session is running.
        writeFileSync(generatedDeclaration, "interface Env {}\n", "utf8");
        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, generatedDeclaration)).toBe(true);
    });

    it("takes the last of duplicate `exclude` keys, as the runtime config does", () => {
        expect.assertions(1);

        mkdirSync(join(lunoraDirectory, "seed"), { recursive: true });
        writeFileSync(join(lunoraDirectory, "seed", "rows.ts"), "export const rows = 1;\n", "utf8");
        writeConfig(`export default { codegen: { exclude: ["other/**"], exclude: ["seed/**"] } };\n`);

        expect(listLunoraSourceFiles(lunoraDirectory).map((path) => path.slice(lunoraDirectory.length + 1))).not.toContain(join("seed", "rows.ts"));
    });

    it("registers a file an outside source starts importing on the refresh that adds the import", () => {
        expect.assertions(1);

        const helperPath = join(workdir, "src", "helper.ts");

        writeFileSync(helperPath, "export const helper = 1;\n", "utf8");

        const project = createCodegenProject(lunoraDirectory);

        // `src/validators.ts` gains an import the Project has not seen yet.
        writeFileSync(
            validatorsPath,
            `import { v } from "@lunora/values";\nimport { helper } from "./helper";\n\nexport const itemValidator = v.object({ title: v.string() });\nexport const unused = helper;\n`,
            "utf8",
        );
        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, helperPath)).toBe(true);
    });

    it("adds a worker entry created after the Project was built, on the next refresh", () => {
        expect.assertions(2);

        const entryPath = join(workdir, "src", "server", "index.ts");
        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, entryPath)).toBe(false);

        mkdirSync(join(workdir, "src", "server"), { recursive: true });
        writeFileSync(entryPath, "export default { fetch: () => new Response() };\n", "utf8");
        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, entryPath)).toBe(true);
    });

    it("does not seed a frontend module whose only global-looking text is in a comment", () => {
        expect.assertions(1);

        writeFileSync(
            componentPath,
            'export const App = () => null;\n// declare global { var __COMMENTED__: number; }\n/* /// <reference types="node" /> */\n',
            "utf8",
        );

        expect(loaded(createCodegenProject(lunoraDirectory), componentPath)).toBe(false);
    });

    it("does not seed an augmentation a comment names by quoted specifier", () => {
        expect.assertions(1);

        const augmentPath = join(workdir, "src", "react-augment.ts");

        writeFileSync(augmentPath, 'import "./routes";\n\ndeclare module "react" {\n    interface Attributes {}\n}\n', "utf8");
        writeFileSync(join(workdir, "src", "routes.ts"), "export const routes = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "probe.ts"), "// see \"react\" and 'react/jsx-runtime'\nexport const probe = 1;\n", "utf8");

        expect(loaded(createCodegenProject(lunoraDirectory), augmentPath)).toBe(false);
    });

    it("seeds a relative augmentation when a lunora/ source imports the same file by another relative path", () => {
        expect.assertions(1);

        const routesPath = join(workdir, "src", "routes.ts");
        const augmentPath = join(workdir, "src", "routes-augment.ts");

        writeFileSync(routesPath, "export const routes = 1;\n", "utf8");
        // Augments `./routes` from its own folder; the lunora/ source below reaches the same file as `../src/routes`.
        writeFileSync(augmentPath, 'export {};\n\ndeclare module "./routes" {\n    interface Registered {\n        ok: true;\n    }\n}\n', "utf8");
        writeFileSync(join(lunoraDirectory, "usesRoutes.ts"), 'import "../src/routes";\n\nexport const used = 1;\n', "utf8");

        expect(loaded(createCodegenProject(lunoraDirectory), augmentPath)).toBe(true);
    });

    it("seeds an augmentation of a module that a file a lunora/ source imports reaches", () => {
        expect.assertions(2);

        const helperPath = join(workdir, "src", "helper.ts");
        const augmentPath = join(workdir, "src", "fake-mod-augment.ts");

        // The augmentation names `fake-mod`, which only the helper imports.
        writeFileSync(helperPath, 'import "fake-mod";\n\nexport const helper = 1;\n', "utf8");
        writeFileSync(augmentPath, 'export {};\n\ndeclare module "fake-mod" {\n    interface Registered {\n        ok: true;\n    }\n}\n', "utf8");
        writeFileSync(join(lunoraDirectory, "usesHelper.ts"), 'import { helper } from "../src/helper";\n\nexport const used = helper;\n', "utf8");

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, augmentPath)).toBe(true);

        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, augmentPath)).toBe(true);
    });

    it("drops a file a lunora/ source stops importing, and keeps the program when nothing changes", () => {
        expect.assertions(3);

        const listItems = join(lunoraDirectory, "listItems.ts");
        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, validatorsPath)).toBe(true);

        // Refreshing with nothing changed rebuilds nothing: the same program object comes back.
        const before = project.getProgram().compilerObject;

        refreshCodegenProject(project, lunoraDirectory);

        expect(project.getProgram().compilerObject).toBe(before);

        writeFileSync(
            listItems,
            readFileSync(listItems, "utf8")
                .replace(`import { itemValidator } from "../src/validators";\n`, "")
                .replace("args: { item: itemValidator }", "args: {}"),
            "utf8",
        );
        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, validatorsPath)).toBe(false);
    });

    it("holds every file a run reads with lint on too, so secret discovery adds none once the program exists", () => {
        expect.assertions(1);

        // A test file under lunora/ is skipped by the default walk; lint's secret scan
        // reads it, and must not add it to the program.
        writeFileSync(join(lunoraDirectory, "listItems.test.ts"), 'export const fixture = "sk_live_0000000000000000000000";\n', "utf8");

        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        const project = createCodegenProject(lunoraDirectory);
        const seeded = new Set(project.getSourceFiles().map((file) => file.getFilePath()));

        runCodegen({ dryRun: true, lint: true, project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(
            project
                .getSourceFiles()
                .map((file) => file.getFilePath())
                .filter((path) => !seeded.has(path)),
        ).toStrictEqual([]);
    });

    it('treats every non-declaration file as a module under moduleDetection "force"', () => {
        expect.assertions(2);

        const plainPath = join(workdir, "src", "plain.ts");

        writeFileSync(plainPath, "interface PlainGlobal {\n    marker: true;\n}\n", "utf8");
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { moduleDetection: "force", strict: true }, include: ["src/**/*", "lunora/**/*"] }),
            "utf8",
        );

        expect(loaded(createCodegenProject(lunoraDirectory), plainPath)).toBe(false);

        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { moduleDetection: "auto", strict: true }, include: ["src/**/*", "lunora/**/*"] }),
            "utf8",
        );

        expect(loaded(createCodegenProject(lunoraDirectory), plainPath)).toBe(true);
    });

    it("treats a CommonJS JavaScript file as a module, so it is not seeded as a global script", () => {
        expect.assertions(2);

        const commonJsPath = join(workdir, "src", "postcss.config.js");
        const scriptPath = join(workdir, "src", "legacy-script.js");

        writeFileSync(commonJsPath, "const plugins = require('./plugins');\nmodule.exports = { plugins };\n", "utf8");
        writeFileSync(scriptPath, "var legacyGlobal = 1;\n", "utf8");
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { allowJs: true, strict: true }, include: ["src/**/*", "lunora/**/*"] }),
            "utf8",
        );

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, commonJsPath)).toBe(false);
        expect(loaded(project, scriptPath)).toBe(true);
    });

    it("treats a JavaScript file that only assigns module.exports as CommonJS", () => {
        expect.assertions(1);

        const exportsPath = join(workdir, "src", "exports-only.js");

        writeFileSync(exportsPath, "module.exports = { value: 1 };\n", "utf8");
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { allowJs: true, strict: true }, include: ["src/**/*", "lunora/**/*"] }),
            "utf8",
        );

        expect(loaded(createCodegenProject(lunoraDirectory), exportsPath)).toBe(false);
    });

    it("keeps a file a lunora/ source references by triple-slash path, though nothing imports it", () => {
        expect.assertions(1);

        const referencedPath = join(workdir, "src", "referenced.ts");

        writeFileSync(referencedPath, "export const referenced = 1;\n", "utf8");
        writeFileSync(join(lunoraDirectory, "usesReference.ts"), '/// <reference path="../src/referenced.ts" />\n\nexport const used = 1;\n', "utf8");

        const project = createCodegenProject(lunoraDirectory);

        refreshCodegenProject(project, lunoraDirectory);

        expect(loaded(project, referencedPath)).toBe(true);
    });

    it("reads a file the tsconfig extends again for a new Project, so an edit to it takes effect", () => {
        expect.assertions(2);

        const plainPath = join(workdir, "src", "plain.ts");
        const include = ["src/**/*", "lunora/**/*"];

        writeFileSync(plainPath, "interface PlainGlobal {\n    marker: true;\n}\n", "utf8");
        writeFileSync(join(workdir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true }, include }), "utf8");
        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }), "utf8");

        expect(loaded(createCodegenProject(lunoraDirectory), plainPath)).toBe(true);

        // The leaf tsconfig is untouched; only the base it extends changes.
        writeFileSync(join(workdir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { moduleDetection: "force", strict: true }, include }), "utf8");

        expect(loaded(createCodegenProject(lunoraDirectory), plainPath)).toBe(false);
    });
});

/**
 * A global a `lunora/` source uses that only a file outside `lunora/` declares, with
 * no import edge from `lunora/` to it. The whole tsconfig program is the oracle: the
 * seeded program must produce the same output for every case.
 */
describe("globals declared outside lunora/", () => {
    const cases: { expected: string; files: Record<string, string>; handler: string; name: string; probeImports?: string }[] = [
        {
            name: "a script's global declaration",
            files: { "src/globals.ts": "declare var __APP_VERSION__: string;\n" },
            handler: "{ version: __APP_VERSION__ }",
            expected: "version: string",
        },
        {
            name: "a declare global block",
            files: { "src/augment.ts": "export {};\n\ndeclare global {\n    var __FLAG__: boolean;\n}\n" },
            handler: "{ enabled: __FLAG__ }",
            expected: "enabled: boolean",
        },
        {
            name: "a script whose only import and export words sit in a comment",
            files: { "src/globals.ts": "// import and export appear only in this comment\ndeclare var __COMMENTED__: number;\n" },
            handler: "{ commented: __COMMENTED__ }",
            expected: "commented: number",
        },
        {
            name: "a script whose namespace exports, and whose template text after a substitution says export",
            files: {
                "src/app-types.ts": `declare namespace App {\n    export interface Env {\n        x: string;\n    }\n}\n\nconst label = \`\${1} export\`;\n`,
            },
            handler: "{ x: (null as unknown as App.Env).x }",
            expected: "x: string",
        },
        {
            name: "a script whose top-level import alias points at a namespace member",
            files: { "src/app-types.ts": "declare namespace App {\n    export interface Env {\n        x: string;\n    }\n}\n\nimport Env = App.Env;\n" },
            handler: "{ x: (null as unknown as Env).x }",
            expected: "x: string",
        },
        {
            name: "a script that reads a property named export",
            files: { "src/globals.ts": "const config = { export: 1 };\nconst value = config.export;\ndeclare var __PROPERTY__: string;\n" },
            handler: "{ property: __PROPERTY__ }",
            expected: "property: string",
        },
        {
            name: "a script with a regex literal that contains export",
            files: { "src/globals.ts": "const pattern = /export/;\ndeclare var __PATTERN__: number;\n" },
            handler: "{ pattern: __PATTERN__ }",
            expected: "pattern: number",
        },
        {
            name: "a script whose JSX text says import",
            files: { "src/view.tsx": "const view = <p>import the data</p>;\ndeclare var __VIEW__: boolean;\n" },
            handler: "{ view: __VIEW__ }",
            expected: "view: boolean",
        },
        {
            name: "a declare module for a specifier the lunora source imports",
            files: { "src/virtual.ts": 'declare module "virtual-mode" {\n    export const mode: "dev" | "prod";\n}\n' },
            probeImports: 'import { mode } from "virtual-mode";\n',
            handler: "{ mode }",
            expected: 'mode: "dev" | "prod"',
        },
        {
            name: "a triple-slash types reference in a program file",
            files: {
                "node_modules/@types/virtual-env/index.d.ts": "declare var __ENV__: string;\n",
                "src/main.ts": '/// <reference types="virtual-env" />\n\nexport const main = 1;\n',
            },
            handler: "{ env: __ENV__ }",
            expected: "env: string",
        },
    ];

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-globals-"));
        lunoraDirectory = join(workdir, "lunora");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });
        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*", "lunora/**/*"] }), "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it.each(cases)("emits the whole tsconfig program's output for $name", ({ files, probeImports = "", handler, expected }) => {
        expect.assertions(2);

        for (const [relativePath, source] of Object.entries(files)) {
            mkdirSync(dirname(join(workdir, relativePath)), { recursive: true });
            writeFileSync(join(workdir, relativePath), source, "utf8");
        }

        writeFileSync(
            join(lunoraDirectory, "probe.ts"),
            `import { query } from "@lunora/server";\n${probeImports}\nexport const probe = query({\n    args: {},\n    handler: async () => (${handler}),\n});\n`,
            "utf8",
        );

        const generate = (project: Project) => runCodegen({ dryRun: true, lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] }).generated;
        // The whole tsconfig program, built the way a plain `new Project` would be.
        const oracle = generate(new Project({ tsConfigFilePath: join(workdir, "tsconfig.json"), useInMemoryFileSystem: false }));

        expect(oracle.functions).toContain(expected);
        expect(generate(createCodegenProject(lunoraDirectory))).toStrictEqual(oracle);
    });

    it("does not load a module augmentation of a module no lunora/ source names, nor the files it pulls in", () => {
        expect.assertions(3);

        // A router augmentation: the file imports the route tree, which imports the
        // whole frontend. `lunora/` names `reactive` in a comment, which must not count
        // as naming `react`.
        const routerPath = join(workdir, "src", "router.tsx");
        const routesPath = join(workdir, "src", "routes.ts");

        writeFileSync(routesPath, "export const routes = 1;\n", "utf8");
        writeFileSync(routerPath, 'import "./routes";\n\ndeclare module "@tanstack/react-router" {\n    interface Register {}\n}\n', "utf8");
        writeFileSync(join(workdir, "src", "react-augment.ts"), 'import "./routes";\n\ndeclare module "react" {\n    interface Attributes {}\n}\n', "utf8");
        writeFileSync(join(lunoraDirectory, "probe.ts"), "// reactive queries\nexport const probe = 1;\n", "utf8");

        const project = createCodegenProject(lunoraDirectory);

        expect(loaded(project, routerPath)).toBe(false);
        expect(loaded(project, join(workdir, "src", "react-augment.ts"))).toBe(false);
        expect(loaded(project, routesPath)).toBe(false);
    });
});
