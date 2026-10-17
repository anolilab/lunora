import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transform } from "esbuild";
import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { emitShard } from "../src/emit";

const SCHEMA = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        messages: defineTable({ text: v.string() }),
    });
`;

const emit = (lazyFunctions: boolean): string => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, SCHEMA);

    return emitShard({ lazyFunctions, schema: discoverSchema(project, schemaPath) });
};

const generatedHandleRpcMethod = (): string => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const shardPath = "/virtual/lunora/_generated/shard.ts";
    const sourceFile = project.createSourceFile(shardPath, emit(true));
    const method = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration).find((declaration) => declaration.getName() === "handleRpc");

    if (!method) {
        throw new Error("Generated lazy shard does not contain handleRpc");
    }

    return method.getText();
};

describe("emitted lazy function dispatch", () => {
    it("keeps eager output free of lazy loading behavior", () => {
        expect.assertions(2);

        const shard = emit(false);

        expect(shard).not.toContain("getLoadedFunction");
        expect(shard).not.toContain("prepareFunctionInRequestScope");
    });

    it("keeps preparation synchronous after module resolution and pins request-scoped entry points", () => {
        expect.assertions(17);

        const shard = emit(true);

        expect(shard).toContain("import { LUNORA_FUNCTIONS, LUNORA_LIFECYCLE_HOOKS, LUNORA_MIGRATIONS, getLoadedFunction, loadFunction }");
        expect(shard).toContain(
            'protected override prepareFunction(functionPath: string, reason: "rpc" | "subscription" | "stream" | "reactor"): Promise<void> | undefined {',
        );
        expect(shard).toContain('const allowsInternal = reason === "reactor" || (reason === "rpc" && this.isSystemDispatch());');
        expect(shard).toContain("if (getLoadedFunction(functionPath) !== undefined) {");
        expect(shard).toContain("return loadFunction(functionPath).then(() => undefined);");
        expect(shard).toContain("const loaded = getLoadedFunction(functionPath) ?? await loadFunction(functionPath);");
        expect(shard).toContain("const requestScope = this.captureRequestScope();");
        expect(shard).toContain('const preparation = this.prepareFunction(functionPath, "rpc");');
        expect(shard).toContain('this.prepareFunction(functionPath, "subscription");');
        expect(shard).toContain('this.prepareFunction(functionPath, "reactor");');

        const subscriptionStart = shard.indexOf("protected override async executeSubscription");
        const streamStart = shard.indexOf("protected override executeStream", subscriptionStart);
        const subscriptionMethods = shard.slice(subscriptionStart, streamStart);
        const internalGate = subscriptionMethods.indexOf('registered.visibility === "internal"');

        expect(internalGate).toBeGreaterThanOrEqual(0);
        expect(subscriptionMethods.indexOf('this.prepareFunction(functionPath, "subscription")')).toBeGreaterThan(internalGate);
        expect(shard).toContain("await preparation;");
        expect(shard).toContain("this.restoreRequestScope(requestScope);");
        expect(shard.match(/const requestScope = this\.captureRequestScope\(\);/gu)).toHaveLength(2);
        expect(shard).not.toContain("prepareFunctionInRequestScope");
        expect(shard).not.toContain("protected override async prepareFunction(");
    });

    it("rejects external internal calls before preparation while allowing trusted system dispatch", async () => {
        expect.assertions(6);

        const projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-shard-dispatch-"));
        const runnerFile = join(projectRoot, "run-handle-rpc.mjs");
        const generatedMethod = generatedHandleRpcMethod();

        try {
            const runnerSource = `class LunoraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const LUNORA_FUNCTIONS = {
  "private:read": { args: {}, kind: "action", visibility: "internal", handler() { throw new Error("unprepared handler"); } }
};
const functionRegistry = LUNORA_FUNCTIONS;
const flushDeferredDeletes = () => undefined;
class TestShard {
  constructor(system) { this.system = system; this.preparations = 0; this.handlerCalls = 0; this.restores = 0; }
  captureRequestScope() { return {}; }
  async prepareFunction(functionPath) {
    this.preparations += 1;
    if (!this.system) throw new Error("private procedure module evaluated");
    functionRegistry[functionPath].handler = (_ctx, args) => { this.handlerCalls += 1; return { value: args.value }; };
  }
  restoreRequestScope() { this.restores += 1; }
  isSystemDispatch() { return this.system; }
  ensureMigrated() {}
  buildCtx() { return {}; }
  async deferPastResponse() {}
${generatedMethod}
}
const external = new TestShard(false);
let externalError;
try { await external.handleRpc("private:read", { value: "external" }); } catch (error) { externalError = error; }
const system = new TestShard(true);
const systemResult = await system.handleRpc("private:read", { value: "trusted" });
process.stdout.write(JSON.stringify({
  externalCode: externalError?.code,
  externalPreparations: external.preparations,
  systemHandlerCalls: system.handlerCalls,
  systemPreparations: system.preparations,
  systemRestores: system.restores,
  systemResult,
}));
`;
            const transformed = await transform(runnerSource, { format: "esm", loader: "ts", target: "node22" });
            writeFileSync(runnerFile, transformed.code);

            const result = JSON.parse(execFileSync(process.execPath, [runnerFile], { encoding: "utf8" })) as {
                externalCode: string;
                externalPreparations: number;
                systemHandlerCalls: number;
                systemPreparations: number;
                systemRestores: number;
                systemResult: { value: string };
            };

            expect(result.externalCode).toBe("FUNCTION_NOT_FOUND");
            expect(result.externalPreparations).toBe(0);
            expect(result.systemResult).toEqual({ value: "trusted" });
            expect(result.systemPreparations).toBe(1);
            expect(result.systemRestores).toBe(1);
            expect(result.systemHandlerCalls).toBe(1);
        } finally {
            rmSync(projectRoot, { force: true, recursive: true });
        }
    });
});
