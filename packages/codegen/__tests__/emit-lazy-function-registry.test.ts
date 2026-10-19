import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, transform } from "esbuild";
import { createProgram, flattenDiagnosticMessageText, getPreEmitDiagnostics, ModuleKind, ModuleResolutionKind, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";

import { emitFunctions, emitLazyFunctionModules } from "../src/emit";
import type { FunctionIR, MutatorIR } from "../src/ir";

const makeFunction = (exportName: string, overrides: Partial<FunctionIR> = {}): FunctionIR => {
    return {
        args: { id: { kind: "string" } },
        exportName,
        filePath: "posts",
        kind: "query",
        returnType: "string",
        ...overrides,
    };
};

const typecheckGeneratedFunctions = (projectRoot: string, source: string): ReadonlyArray<string> => {
    const generatedDirectory = join(projectRoot, "_generated");
    const functionsFile = join(generatedDirectory, "functions.ts");
    writeFileSync(functionsFile, source);

    const program = createProgram({
        options: {
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.Bundler,
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: ScriptTarget.ES2022,
            types: [],
        },
        rootNames: [functionsFile],
    });

    return getPreEmitDiagnostics(program).map((diagnostic) => flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};

const makeFunctionTypecheckProject = (projectRoot: string): void => {
    const generatedDirectory = join(projectRoot, "_generated");
    const generatedFunctionDirectory = join(generatedDirectory, "fn");
    const serverPackage = join(projectRoot, "node_modules", "@lunora", "server");
    mkdirSync(generatedFunctionDirectory, { recursive: true });
    mkdirSync(serverPackage, { recursive: true });

    writeFileSync(join(serverPackage, "index.d.ts"), "export class LunoraError extends Error { constructor(code: string, message: string); code: string; }\n");
    writeFileSync(
        join(generatedDirectory, "server.ts"),
        "export type ActionCtx = {}; export type MutationCtx = {}; export type QueryCtx = {}; export type RoomMessageOf<T> = unknown;\n",
    );
    writeFileSync(join(generatedDirectory, "dataModel.ts"), "export type Id<Table extends string = string> = string & { readonly __table: Table };\n");
    writeFileSync(
        join(projectRoot, "posts.ts"),
        'export const premium = { args: {}, kind: "query" as const, handler: (_ctx: unknown, _args: { id: string }) => "ok" };\n',
    );
    writeFileSync(
        join(generatedFunctionDirectory, "lunora_posts_0.ts"),
        'export const premium = { args: {}, kind: "query" as const, handler: (_ctx: unknown, _args: { id: string }) => "ok" };\n',
    );
};

describe("lazy function registry", () => {
    it("checks lazy placeholder metadata without changing its emitted JavaScript", async () => {
        expect.assertions(5);

        const projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-registry-types-"));

        try {
            makeFunctionTypecheckProject(projectRoot);
            const source = emitFunctions({
                functions: [makeFunction("premium", { expose: { rest: true }, x402: { price: "$0.05" } })],
                lazyFunctions: true,
            });
            const checkedType = 'satisfies RegisteredLunoraFunction & Pick<FunctionManifestEntry, "argumentDescriptors" | "channel" | "expose">';
            const invalidPlaceholder = source.replace(/(handler: unloadedFunctionHandler, \.\.\..*?)"kind":"query"/u, '$1"kind":"invalid"');
            const oldCastControl = invalidPlaceholder.replaceAll(checkedType, "as unknown as RegisteredLunoraFunction");

            expect(typecheckGeneratedFunctions(projectRoot, source)).toEqual([]);
            expect(invalidPlaceholder).not.toBe(source);
            expect(typecheckGeneratedFunctions(projectRoot, invalidPlaceholder)).toEqual([
                expect.stringContaining("Type '\"invalid\"' is not assignable"),
                expect.stringContaining("does not satisfy the expected type"),
            ]);
            expect(typecheckGeneratedFunctions(projectRoot, oldCastControl)).toEqual([]);

            const checked = await transform(source, { loader: "ts", target: "es2022" });
            const asserted = await transform(source.replaceAll(checkedType, "as unknown as RegisteredLunoraFunction"), { loader: "ts", target: "es2022" });

            expect(checked.code).toBe(asserted.code);
        } finally {
            rmSync(projectRoot, { force: true, recursive: true });
        }
    });

    it("emits static paid and REST metadata while deferring the user module and AOT validators", () => {
        expect.assertions(8);

        const definition = makeFunction("premium", {
            expose: { cache: { maxAge: 60, scope: "private" }, rest: true },
            x402: { price: "$0.05" },
        });
        const options = { functions: [definition], lazyFunctions: true };
        const emitted = emitFunctions(options);
        const modules = emitLazyFunctionModules(options);
        const module = modules["lunora_posts_0.ts"] ?? "";

        expect(emitted).not.toContain('import * as lunora_posts_0 from "../posts.js";');
        expect(emitted).toContain('"posts:premium": { args: {}, handler: unloadedFunctionHandler');
        expect(emitted).toContain(
            '"posts:premium": {"argumentDescriptors":[{"kind":"string","name":"id","optional":false}],"exportName":"premium","kind":"query","moduleId":"lunora_posts_0","expose":{"cache":{"maxAge":60,"scope":"private"},"rest":true},"x402":{"price":"$0.05"}}',
        );
        expect(emitted).toContain('"lunora_posts_0": () => import("./fn/lunora_posts_0.js")');
        expect(emitted).toContain("const loaded = module[manifest.exportName];");
        expect(emitted).not.toContain("installCompiledValidatorMap");
        expect(module).toContain('import * as lunora_posts_0 from "../../posts.js";');
        expect(module).toContain("installCompiledValidatorMap(lunora_posts_0.premium.args");
    });

    it("deduplicates handlers from the same module and emits room routes without loading handlers", () => {
        expect.assertions(4);

        const first = makeFunction("one");
        const second = makeFunction("two", { args: {}, returnType: "void" });
        const room = makeFunction("chat", { args: {}, channel: { kind: "room", name: "chat" } });
        const options = { functions: [first, second, room], lazyFunctions: true };
        const emitted = emitFunctions(options);
        const modules = emitLazyFunctionModules(options);

        expect(Object.keys(modules)).toEqual(["lunora_posts_0.ts"]);
        expect(emitted.match(/\(\) => import\("\.\/fn\/lunora_posts_0\.js"\)/gu)).toHaveLength(1);
        expect(emitted).toContain('topic: "room:chat"');
        expect(emitted).not.toContain("for (const [path, fn] of Object.entries(LUNORA_FUNCTIONS))");
    });

    it("fails closed when a lazy paid procedure has a dynamic price", () => {
        expect.assertions(1);

        expect(() => emitFunctions({ functions: [makeFunction("premium", { x402: {} })], lazyFunctions: true })).toThrow(/literal `.x402\(\{ price \}\)`/u);
    });

    it("rejects code-bearing file paths before emitting lazy import specifiers", () => {
        expect.assertions(1);

        const injectedPath = 'posts"; throw new Error("unexpected import") //';

        expect(() => emitFunctions({ functions: [makeFunction("list", { filePath: injectedPath })], lazyFunctions: true })).toThrow(/unsafe file path/u);
    });

    it("never evicts a failed module from the loader cache", () => {
        expect.assertions(2);

        // Node caches a module that threw, so an end-to-end run cannot tell a retry from a rethrow;
        // pin the registry itself: a failed load stays in the cache and every call rethrows it.
        const emitted = emitFunctions({ functions: [makeFunction("list")], lazyFunctions: true });

        expect(emitted).not.toContain("loadedModules.delete(");
        expect(emitted).toContain("loadedModules.set(manifest.moduleId, pending);");
    });

    it("emits the smoke loader only when there is a lazy entry for it to check", () => {
        expect.assertions(2);

        const withoutLazyEntries = emitFunctions({ functions: [], lazyFunctions: true });
        const withLazyEntries = emitFunctions({ functions: [makeFunction("list")], lazyFunctions: true });

        expect(withoutLazyEntries).not.toContain("loadAllFunctions");
        expect(withLazyEntries).toContain("export const loadAllFunctions");
    });

    it("keeps eager output unchanged unless lazy mode is selected", () => {
        expect.assertions(3);

        const emitted = emitFunctions({ functions: [makeFunction("list")] });

        expect(emitted).toContain('import * as lunora_posts_0 from "../posts.js";');
        expect(emitted).toMatch(/const registered = LUNORA_FUNCTIONS\[functionPath\];/u);
        expect(emitted).not.toContain("LUNORA_FUNCTION_MANIFEST");
    });

    it("loads real handlers once, installs compiled validators, and keeps a failed module failed", async () => {
        expect.assertions(26);

        const projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-registry-"));
        const generatedDirectory = join(projectRoot, "_generated");
        const shimDirectory = join(generatedDirectory, "fn");
        const packageDirectory = join(projectRoot, "node_modules", "@lunora");
        const stateName = `__lunoraLazyRegistry${randomUUID()}`;
        const definition = makeFunction("premium", { args: { name: { kind: "string" } } });
        const sameModule = makeFunction("sameModule", { args: {}, filePath: "mutators" });
        const internalDefinition = makeFunction("hidden", { filePath: "private", visibility: "internal" });
        const mutator: MutatorIR = { args: {}, exportName: "default", filePath: "mutators", line: 1, returnType: "string" };
        const options = {
            functions: [definition, makeFunction("sibling", { args: {} }), sameModule, internalDefinition],
            lazyFunctions: true,
            mutators: [mutator],
        };
        const registrySource = emitFunctions(options);
        const lazyModules = emitLazyFunctionModules(options);
        const shimSource = lazyModules["lunora_posts_0.ts"];
        const internalShimSource = lazyModules["lunora_private_2.ts"];

        try {
            if (shimSource === undefined || internalShimSource === undefined) {
                throw new Error("Missing generated lazy function shim: fn/lunora_posts_0.ts");
            }

            mkdirSync(shimDirectory, { recursive: true });
            mkdirSync(join(packageDirectory, "server"), { recursive: true });
            mkdirSync(join(packageDirectory, "errors"), { recursive: true });
            mkdirSync(join(packageDirectory, "values"), { recursive: true });
            writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ type: "module" }));
            writeFileSync(join(packageDirectory, "server", "package.json"), JSON.stringify({ exports: "./index.js", type: "module" }));
            writeFileSync(
                join(packageDirectory, "server", "index.js"),
                "export class LunoraError extends Error { constructor(code, message) { super(message); this.code = code; } }\n",
            );
            writeFileSync(join(packageDirectory, "errors", "package.json"), JSON.stringify({ exports: "./index.js", type: "module" }));
            writeFileSync(join(packageDirectory, "errors", "index.js"), "export class LunoraError extends Error {}\n");
            writeFileSync(join(packageDirectory, "values", "package.json"), JSON.stringify({ exports: "./index.js", type: "module" }));
            await build({
                bundle: true,
                entryPoints: [new URL("../../values/src/validator-map.ts", import.meta.url).pathname],
                external: ["@lunora/errors"],
                format: "esm",
                outfile: join(packageDirectory, "values", "index.js"),
                platform: "node",
            });
            writeFileSync(
                join(projectRoot, "posts.js"),
                `const state = globalThis[${JSON.stringify(stateName)}];
state.evaluations += 1;
state.onStart();
await new Promise((resolve) => { state.release = resolve; });
export const premium = {
  args: { name: { kind: "string", parse(value) { state.parseCalls += 1; return value; } } },
  kind: "query",
  handler(_context, args) { state.handlerCalls += 1; return args.name; }
};
export const sibling = { args: {}, kind: "query", handler() { return "sibling"; } };\n`,
            );
            writeFileSync(
                join(projectRoot, "mutators.js"),
                `const state = globalThis[${JSON.stringify(stateName)}];
state.mutatorModuleEvaluations += 1;
export default {
  args: {},
  kind: "mutation",
  handler(_context, args) { state.mutatorCalls += 1; return "mutator:" + args.id; }
};
export const sameModule = { args: {}, kind: "query", handler() { return "same module"; } };\n`,
            );
            writeFileSync(
                join(projectRoot, "private.js"),
                `const state = globalThis[${JSON.stringify(stateName)}];
state.privateModuleEvaluations += 1;
throw new Error("internal module must not be loaded by external dispatch");
export const hidden = { args: {}, kind: "query", handler() { return "hidden"; } };\n`,
            );

            const registryFile = join(generatedDirectory, "functions.mjs");
            const shimFile = join(shimDirectory, "lunora_posts_0.js");
            const internalShimFile = join(shimDirectory, "lunora_private_2.js");
            const shimPayloadFile = join(projectRoot, "lazy-shim.js");
            const internalShimPayloadFile = join(projectRoot, "private-lazy-shim.js");
            const registryModule = await transform(registrySource, { format: "esm", loader: "ts", target: "node22" });
            const shimModule = await transform(shimSource, { format: "esm", loader: "ts", target: "node22" });
            const internalShimModule = await transform(internalShimSource, { format: "esm", loader: "ts", target: "node22" });

            writeFileSync(registryFile, registryModule.code);
            writeFileSync(shimPayloadFile, shimModule.code);
            writeFileSync(internalShimPayloadFile, internalShimModule.code);

            const runnerFile = join(projectRoot, "run-lazy-registry.mjs");
            writeFileSync(
                runnerFile,
                // eslint-disable-next-line no-secrets/no-secrets -- false positive: a generated runner script, not a credential.
                `import { copyFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [configText] = process.argv.slice(2);
const config = JSON.parse(configText);
const state = { evaluations: 0, handlerCalls: 0, parseCalls: 0, mutatorCalls: 0, mutatorModuleEvaluations: 0, privateModuleEvaluations: 0, release: undefined, onStart: undefined };
let signalStart;
const moduleStarted = new Promise((resolve) => { signalStart = resolve; });
state.onStart = signalStart;
globalThis[config.stateName] = state;

const registry = await import(pathToFileURL(config.registryFile));
copyFileSync(config.internalShimPayloadFile, config.internalShimFile);
let internalDispatchCode;
try {
  await registry.dispatchLunoraFunction("private:hidden", {}, {});
} catch (error) {
  internalDispatchCode = error.code;
}
const internalModuleEvaluations = state.privateModuleEvaluations;
copyFileSync(config.shimPayloadFile, config.shimFile);
const coldEntry = registry.getLoadedFunction("posts:premium");
const first = registry.loadFunction("posts:premium");
const second = registry.loadFunction("posts:premium");
await moduleStarted;
const coalescedEvaluations = state.evaluations;
state.release();
await Promise.all([first, second]);
const { LUNORA_FUNCTIONS: handlers } = registry;
const loaded = handlers["posts:premium"];
const mutator = registry.getLoadedFunction("mutators:default");
const mutatorResult = await mutator.handler({}, { id: "m1" });
const sameModule = registry.getLoadedFunction("mutators:sameModule");
const values = await import(pathToFileURL(config.valuesFile));
const parsed = values.parseValidatorMap(loaded.args, { extra: true, name: "Ada" }, "args");
const handlerResult = await loaded.handler({}, { name: "Ada" });
const cachedEntry = await registry.loadFunction("posts:premium");
const synchronousEntry = registry.getLoadedFunction("posts:premium");
const sibling = registry.getLoadedFunction("posts:sibling");
const brokenAttempts = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    await registry.loadFunction("private:hidden");
    brokenAttempts.push("loaded");
  } catch (error) {
    brokenAttempts.push(error.message);
  }
}

const allLoaded = await registry.loadAllFunctions();

process.stdout.write(JSON.stringify({
  allLoaded,
  cacheReusedEntry: cachedEntry === loaded,
  coldEntryMissing: coldEntry === undefined,
  synchronousEntry: synchronousEntry === loaded,
  siblingResult: sibling.handler(),
  coalescedEvaluations,
  finalEvaluations: state.evaluations,
  brokenAttempts,
  brokenEvaluations: state.privateModuleEvaluations,
  handlerCalls: state.handlerCalls,
  handlerResult,
  internalDispatchCode,
  internalModuleEvaluations,
  mutatorCalls: state.mutatorCalls,
  mutatorDirect: mutator === handlers["mutators:default"],
  mutatorInManifest: Object.hasOwn(registry[["LUNORA", "FUNCTION", "MANIFEST"].join("_")], ["mutators", "default"].join(":")),
  mutatorModuleEvaluations: state.mutatorModuleEvaluations,
  mutatorPathRegistered: registry[["LUNORA", "MUTATOR", "PATHS"].join("_")].has(["mutators", "default"].join(":")),
  mutatorResult,
  sameModuleResult: sameModule.handler(),
  parseCalls: state.parseCalls,
  parsed,
}));
Reflect.deleteProperty(globalThis, config.stateName);
`,
            );
            const output = execFileSync(
                process.execPath,
                [
                    runnerFile,
                    JSON.stringify({
                        registryFile,
                        shimFile,
                        shimPayloadFile,
                        internalShimFile,
                        internalShimPayloadFile,
                        stateName,
                        valuesFile: join(packageDirectory, "values", "index.js"),
                    }),
                ],
                { encoding: "utf8" },
            );
            const result = JSON.parse(output) as {
                allLoaded: { checked: number; failures: { functionPath: string; message: string }[] };
                brokenAttempts: string[];
                brokenEvaluations: number;
                cacheReusedEntry: boolean;
                coalescedEvaluations: number;
                coldEntryMissing: boolean;
                finalEvaluations: number;
                handlerCalls: number;
                handlerResult: string;
                internalDispatchCode: string | undefined;
                internalModuleEvaluations: number;
                mutatorCalls: number;
                mutatorDirect: boolean;
                mutatorInManifest: boolean;
                mutatorModuleEvaluations: number;
                mutatorPathRegistered: boolean;
                mutatorResult: string;
                parseCalls: number;
                parsed: Record<string, unknown>;
                sameModuleResult: string;
                siblingResult: string;
                synchronousEntry: boolean;
            };

            expect(result.brokenAttempts).toStrictEqual([
                "internal module must not be loaded by external dispatch",
                "internal module must not be loaded by external dispatch",
            ]);
            expect(result.brokenEvaluations).toBe(1);
            // The pre-deploy smoke-load: every module is evaluated up front and only the broken one is reported.
            expect(result.allLoaded).toStrictEqual({
                checked: 3,
                failures: [{ functionPath: "private:hidden", message: "internal module must not be loaded by external dispatch" }],
            });
            expect(result.coalescedEvaluations).toBe(1);
            expect(result.finalEvaluations).toBe(1);
            expect(result.cacheReusedEntry).toBe(true);
            expect(result.coldEntryMissing).toBe(true);
            expect(result.synchronousEntry).toBe(true);
            expect(result.siblingResult).toBe("sibling");
            expect(result.handlerCalls).toBe(1);
            expect(result.handlerResult).toBe("Ada");
            expect(result.internalModuleEvaluations).toBe(0);
            expect(result.internalDispatchCode).toBe("FUNCTION_NOT_FOUND");
            expect(result.parsed).toEqual({ name: "Ada" });
            expect(result.parseCalls).toBe(0);
            expect(Object.keys(lazyModules)).toEqual(["lunora_posts_0.ts", "lunora_private_2.ts"]);
            expect(registrySource).toContain('import * as lunora_mutators_1 from "../mutators.js";');
            expect(registrySource).toContain('"mutators:default": lunora_mutators_1.default as unknown as RegisteredLunoraFunction');
            expect(registrySource).toContain('"mutators:sameModule": lunora_mutators_1.sameModule as unknown as RegisteredLunoraFunction');
            expect(result.mutatorDirect).toBe(true);
            expect(result.mutatorInManifest).toBe(false);
            expect(result.mutatorPathRegistered).toBe(true);
            expect(result.mutatorModuleEvaluations).toBe(1);
            expect(result.mutatorResult).toBe("mutator:m1");
            expect(result.mutatorCalls).toBe(1);
            expect(result.sameModuleResult).toBe("same module");
        } finally {
            Reflect.deleteProperty(globalThis, stateName);
            rmSync(projectRoot, { force: true, recursive: true });
        }
    });
});
