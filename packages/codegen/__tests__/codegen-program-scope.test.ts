import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Project } from "ts-morph";
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
 * `codegen.program` decides which files the TypeScript program codegen resolves
 * types over starts from. The tsconfig below includes a whole `src/` (a React
 * component, an ambient declaration) next to `lunora/`; the setting is whether
 * codegen loads that `src/` before it reads a single function.
 */
describe("codegen.program", () => {
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

    it('loads every file the tsconfig includes under `codegen.program: "tsconfig"`', () => {
        expect.assertions(1);

        writeConfig(`export default { codegen: { program: "tsconfig" } };\n`);

        expect(loaded(createCodegenProject(lunoraDirectory), componentPath)).toBe(true);
    });

    it("lets a caller's scope override lunora.config", () => {
        expect.assertions(2);

        writeConfig(`export default { codegen: { program: "tsconfig" } };\n`);

        expect(loaded(createCodegenProject(lunoraDirectory, "lunora"), componentPath)).toBe(false);
        expect(loaded(createCodegenProject(lunoraDirectory, "tsconfig"), componentPath)).toBe(true);
    });

    it("emits the same output from either program", () => {
        expect.assertions(1);

        const fromLunora = runCodegen({
            dryRun: true,
            lint: false,
            project: createCodegenProject(lunoraDirectory, "lunora"),
            projectRoot: workdir,
            wranglerQueueProducers: [],
        });
        const fromTsconfig = runCodegen({
            dryRun: true,
            lint: false,
            project: createCodegenProject(lunoraDirectory, "tsconfig"),
            projectRoot: workdir,
            wranglerQueueProducers: [],
        });

        expect(fromLunora.generated).toStrictEqual(fromTsconfig.generated);
    });

    it("warns and falls back to the default for a `program` it cannot read, without dropping a readable `exclude`", () => {
        expect.assertions(4);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        mkdirSync(join(lunoraDirectory, "seed"), { recursive: true });
        writeFileSync(join(lunoraDirectory, "seed", "rows.ts"), "export const rows = 1;\n", "utf8");
        writeConfig(`export default { codegen: { exclude: ["seed/**"], program: process.env["PROGRAM"] } };\n`);

        const files = listLunoraSourceFiles(lunoraDirectory).map((path) => path.slice(lunoraDirectory.length + 1));

        expect(files).not.toContain(join("seed", "rows.ts"));
        expect(loaded(createCodegenProject(lunoraDirectory), componentPath)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("codegen.program"));
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("codegen.exclude"));
    });

    it("warns about an unreadable `exclude` without losing a readable `program`", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        writeConfig(`export default { codegen: { exclude: ["!seed/**"], program: "tsconfig" } };\n`);

        expect(loaded(createCodegenProject(lunoraDirectory), componentPath)).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("codegen.exclude"));
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("codegen.program"));
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

        const project = createCodegenProject(lunoraDirectory, "lunora");
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
});
