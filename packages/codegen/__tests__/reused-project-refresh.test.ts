import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodegenProject, refreshCodegenProject, runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;
let lunoraDirectory: string;
let validatorsPath: string;

/**
 * `packages/vite/src/codegen-plugin.ts` reuses one ts-morph `Project` across
 * dev-loop codegen runs (`createCodegenProject` once, `refreshCodegenProject`
 * per save) to avoid a ~900ms full reparse on every keystroke. Before this
 * spec, `refreshCodegenProject` only resynced files INSIDE `lunoraDirectory`
 * — so a validator/type shared from outside it (a project's `src/`, pulled in
 * through the root tsconfig) stayed pinned at the version first parsed.
 * `resolveValidatorAlias` (parse-validator.ts) follows `getAliasedSymbol()`
 * across module boundaries, so that stale copy was genuinely read as the
 * current definition — `vite dev` and a fresh `lunora codegen` run would
 * silently emit different output from the same on-disk source.
 */
describe("reused Project — files outside lunora/", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-reuse-"));
        lunoraDirectory = join(workdir, "lunora");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });

        // Every shipped template puts its tsconfig at the project root (see plan
        // 318 §1) — `findTsconfig` walks up from `lunoraDirectory` and finds this.
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" } }),
            "utf8",
        );

        mkdirSync(join(workdir, "src"), { recursive: true });
        validatorsPath = join(workdir, "src", "validators.ts");
        writeFileSync(validatorsPath, `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string() });\n`, "utf8");

        writeFileSync(
            join(lunoraDirectory, "listItems.ts"),
            `import { query } from "@lunora/server";

import { itemValidator } from "../src/validators";

export const listItems = query({
    args: { item: itemValidator },
    handler: async (_context, args) => {
        return args.item;
    },
});
`,
            "utf8",
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reflects an edit to a shared validator outside lunoraDirectory after refreshing the shared Project", () => {
        expect.assertions(4);

        const project = createCodegenProject(lunoraDirectory);

        refreshCodegenProject(project, lunoraDirectory);

        const before = runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(before.generated.functions).toContain("title: string");
        expect(before.generated.functions).not.toContain("age: number");

        // Add a field to the validator on disk — NOT inside lunoraDirectory — then
        // refresh the SAME shared Project (what the plugin does on every save) and
        // re-run. Fails on pre-WS2 code: `age` never reaches the emitted output
        // because the reused Project never resyncs `src/validators.ts`.
        writeFileSync(
            validatorsPath,
            `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string(), age: v.number() });\n`,
            "utf8",
        );
        refreshCodegenProject(project, lunoraDirectory);

        const after = runCodegen({ lint: false, project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(after.generated.functions).toContain("age: number");

        // Control (plan §3.2): a freshly-constructed Project over the same
        // post-edit source must agree byte-for-byte with the refreshed, reused
        // one — `vite dev` and `lunora codegen` may never disagree.
        const fresh = runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(after.generated.functions).toBe(fresh.generated.functions);
    });
});

const readGenerated = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const generatedDirectory = join(root, "lunora", "_generated");

    for (const entry of readdirSync(generatedDirectory, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);

            out.set(relative(generatedDirectory, path), readFileSync(path, "utf8"));
        }
    }

    return out;
};

const procedure = (name: string): string => `export const ${name} = query({
    handler: async (context) => context.db.query("messages").take(1),
});
`;

describe("reused Project — fresh vs reused output", () => {
    let freshDirectory: string | undefined;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-reuse-"));
        lunoraDirectory = join(workdir, "lunora");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" } }),
            "utf8",
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });

        if (freshDirectory) {
            rmSync(freshDirectory, { force: true, recursive: true });
        }
    });

    it("emits the same _generated output after a procedure is appended as a fresh Project does", () => {
        expect.assertions(1);

        const itemsPath = join(lunoraDirectory, "items.ts");

        writeFileSync(itemsPath, `import { query } from "@lunora/server";\n\n${procedure("first")}`, "utf8");

        const project = createCodegenProject(lunoraDirectory);

        runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] });

        appendFileSync(itemsPath, `\n${procedure("extra")}`, "utf8");
        refreshCodegenProject(project, lunoraDirectory);
        runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] });

        const reused = readGenerated(workdir);

        freshDirectory = mkdtempSync(join(tmpdir(), "lunora-codegen-fresh-"));
        cpSync(workdir, freshDirectory, { recursive: true });
        rmSync(join(freshDirectory, "lunora", "_generated"), { force: true, recursive: true });
        runCodegen({ projectRoot: freshDirectory, wranglerQueueProducers: [] });

        expect(reused).toStrictEqual(readGenerated(freshDirectory));
    });
});

/**
 * A stand-in for `@lunora/server`'s builder types, so the `__lunoraProcedure` brand and the
 * `__lunoraVisibility` marker resolve in a temp project without installing the package.
 */
const SERVER_TYPES = `interface Builder { readonly __lunoraProcedure: true; mutation(handler: (input: { ctx: unknown }) => Promise<unknown>): unknown }
interface InternalBuilder extends Builder { readonly __lunoraVisibility: "internal" }
export declare const mutation: Builder;
export declare const internalMutation: InternalBuilder;
`;

const builderModule = (builder: string): string => `import { ${builder} } from "@lunora/server";\n\nexport const appMutation = ${builder};\n`;

const postsModule = (body: string): string =>
    `import { appMutation } from "./lib/builders";\n\nexport const createPost = appMutation.mutation(async ({ ctx }) => ${body});\n`;

/**
 * Codegen caches per-pass work by compiler node and type checker (`classifyProcedureCall`,
 * `descendantsOfKind`). A reused Project must still answer from the source as it is now:
 * an edit to one file can change what an UNCHANGED file classifies as, and an edited
 * handler must be read again rather than served from the previous pass.
 */
describe("reused Project — per-pass caches see edits", () => {
    let freshDirectory: string | undefined;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-reuse-"));
        lunoraDirectory = join(workdir, "lunora");

        const serverPackage = join(workdir, "node_modules", "@lunora", "server");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" } }),
            "utf8",
        );
        mkdirSync(serverPackage, { recursive: true });
        writeFileSync(join(serverPackage, "package.json"), JSON.stringify({ name: "@lunora/server", type: "module", types: "./index.d.ts" }), "utf8");
        writeFileSync(join(serverPackage, "index.d.ts"), SERVER_TYPES, "utf8");
        mkdirSync(join(lunoraDirectory, "lib"), { recursive: true });
        writeFileSync(join(lunoraDirectory, "lib", "builders.ts"), builderModule("mutation"), "utf8");
        writeFileSync(join(lunoraDirectory, "posts.ts"), postsModule("ctx"), "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });

        if (freshDirectory) {
            rmSync(freshDirectory, { force: true, recursive: true });
        }
    });

    /** The `_generated/` a fresh Project writes for the current sources. */
    const freshGenerated = (): Map<string, string> => {
        freshDirectory = mkdtempSync(join(tmpdir(), "lunora-codegen-fresh-"));
        cpSync(workdir, freshDirectory, { recursive: true });
        rmSync(join(freshDirectory, "lunora", "_generated"), { force: true, recursive: true });
        runCodegen({ projectRoot: freshDirectory, wranglerQueueProducers: [] });

        return readGenerated(freshDirectory);
    };

    it("reclassifies a procedure when only the module its builder comes from changes", () => {
        expect.assertions(4);

        const project = createCodegenProject(lunoraDirectory);

        expect(runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] }).generated.api).toContain("createPost");

        // `posts.ts` is untouched: only its builder's module switches to the internal
        // builder, so `createPost` must leave the client-facing `api`.
        writeFileSync(join(lunoraDirectory, "lib", "builders.ts"), builderModule("internalMutation"), "utf8");
        refreshCodegenProject(project, lunoraDirectory);

        const after = runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(after.generated.api).not.toContain("createPost");
        expect(after.generated.internal).toContain("createPost");
        expect(readGenerated(workdir)).toStrictEqual(freshGenerated());
    });

    it("re-reads an edited handler body on the next pass", () => {
        expect.assertions(3);

        const project = createCodegenProject(lunoraDirectory);
        const before = runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(before.advisorContext?.nondeterministicCalls ?? []).toHaveLength(0);

        writeFileSync(join(lunoraDirectory, "posts.ts"), postsModule("[ctx, Math.random()]"), "utf8");
        refreshCodegenProject(project, lunoraDirectory);

        const after = runCodegen({ project, projectRoot: workdir, wranglerQueueProducers: [] });

        expect(after.advisorContext?.nondeterministicCalls).toHaveLength(1);
        expect(readGenerated(workdir)).toStrictEqual(freshGenerated());
    });
});
