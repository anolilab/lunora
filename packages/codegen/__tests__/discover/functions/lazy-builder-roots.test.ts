import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModuleKind, ModuleResolutionKind, Project, SyntaxKind } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../../../src/discover/functions";
import lazyMetadataFromBuilderChain from "../../../src/discover/functions/internal/lazy-metadata";
import { emitApi } from "../../../src/emit/api";
import { emitFunctions } from "../../../src/emit/functions";

let directory: string;
let project: Project;

const serverTypes = `
export interface PublicBuilder {
    __lunoraProcedure: "query";
    query(handler: () => number): unknown;
    expose(config: unknown): PublicBuilder;
    x402(config: unknown): PublicBuilder;
}
export interface InternalBuilder extends PublicBuilder { __lunoraVisibility: "internal"; }
export const query: PublicBuilder;
export const internalQuery: InternalBuilder;
export const initLunora: { dataModel<T>(): { create(): { query: PublicBuilder; internalQuery: InternalBuilder } } };
`;

const addServerTypes = (module: string): void => {
    if (module.startsWith(".")) {
        project.createSourceFile(join(directory, "_generated/server.d.ts"), serverTypes);
    } else {
        project.createSourceFile(join(directory, "server.d.ts"), `declare module "${module}" { ${serverTypes} }`);
    }
};

const verifyDiscovery = (source: string): void => {
    writeFileSync(join(directory, "posts.ts"), source);

    const eager = discoverFunctions(project, directory);
    const lazy = discoverFunctions(project, directory, { lazyFunctions: true });
    const api = emitApi({ functions: lazy });
    const registry = emitFunctions({ functions: lazy, lazyFunctions: true });

    expect(lazy).toEqual(eager);
    expect(
        lazy.map(({ exportName, visibility }) => {
            return { exportName, visibility };
        }),
    ).toEqual([
        { exportName: "secret", visibility: "internal" },
        { exportName: "visible", visibility: "public" },
    ]);
    expect(lazy.find((entry) => entry.exportName === "visible")).toMatchObject({ expose: { rest: true }, x402: { price: "$1" } });
    expect(api).toContain("visible: FunctionReference");
    expect(api).not.toContain("secret");
    expect(registry).toContain('"visibility":"internal"');
    expect(registry).toContain('"x402":{"price":"$1"}');
};

describe("lazy builder roots", () => {
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-lazy-roots-"));
        project = new Project({
            compilerOptions: { module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler },
            skipAddingFilesFromTsConfig: true,
        });
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it.each(["@lunora/server", "lunorash/server", "./_generated/server.js"])("resolves namespace factories from %s", (module) => {
        expect.assertions(7);

        addServerTypes(module);
        verifyDiscovery(`import * as server from "${module}";
export const visible = server.query.expose({ rest: true }).x402({ price: "$1" }).query(() => 1);
export const secret = server.internalQuery.query(() => 2);`);
    });

    it.each([
        'import { initLunora } from "@lunora/server"; const { query, internalQuery } = initLunora.dataModel<{}>().create();',
        'import { initLunora as init } from "@lunora/server"; const { query: publicBase, internalQuery: internalBase } = init.dataModel<{}>().create(); const query = publicBase; const internalQuery = internalBase;',
        'import * as server from "@lunora/server"; const { query, internalQuery } = server.initLunora.dataModel<{}>().create();',
    ])("resolves destructured builder factories: %s", (setup) => {
        expect.assertions(7);

        addServerTypes("@lunora/server");
        verifyDiscovery(`${setup}
export const visible = query.expose({ rest: true }).x402({ price: "$1" }).query(() => 1);
export const secret = internalQuery.query(() => 2);`);
    });

    it("resolves renamed destructured builders imported from another module", () => {
        expect.assertions(7);

        addServerTypes("@lunora/server");
        writeFileSync(
            join(directory, "base.ts"),
            `import { initLunora } from "@lunora/server";
export const { query: publicBase, internalQuery: internalBase } = initLunora.dataModel<{}>().create();`,
        );
        verifyDiscovery(`import { publicBase as query, internalBase as internalQuery } from "./base";
export const visible = query.expose({ rest: true }).x402({ price: "$1" }).query(() => 1);
export const secret = internalQuery.query(() => 2);`);
    });

    it.each([
        'import * as server from "@lunora/server"; const base = server.query;',
        'import { initLunora } from "@lunora/server"; const { query: base } = initLunora.dataModel().create();',
    ])("rejects dynamic metadata on resolved roots: %s", (setup) => {
        expect.assertions(1);

        const source = project.createSourceFile(join(directory, "dynamic.ts"), `${setup}\nexport const value = base.expose(config).query(() => 1);`);
        const receiver = source
            .getVariableDeclarationOrThrow("value")
            .getInitializerIfKindOrThrow(SyntaxKind.CallExpression)
            .getExpressionIfKindOrThrow(SyntaxKind.PropertyAccessExpression)
            .getExpression();

        expect(() => lazyMetadataFromBuilderChain(receiver)).toThrow(/literal metadata objects/u);
    });

    it.each([
        'import * as server from "other-package"; const base = server.query;',
        "const server = { query: {} }; const base = server.query;",
        'import * as server from "@lunora/server"; const base = server["query"];',
        'import { initLunora } from "other-package"; const { query: base } = initLunora.dataModel().create();',
        "const initLunora = { dataModel: () => ({ create: () => ({ query: {} }) }) }; const { query: base } = initLunora.dataModel().create();",
        'import { initLunora } from "@lunora/server"; let { query: base } = initLunora.dataModel().create();',
        'import { initLunora } from "@lunora/server"; const { query: base = fallback } = initLunora.dataModel().create();',
        'import { initLunora } from "@lunora/server"; const { query: base } = wrap(initLunora.dataModel().create());',
        'import { initLunora } from "@lunora/server"; const { query: base } = initLunora.custom().dataModel().create();',
        'import { initLunora } from "@lunora/server"; const { [key]: base } = initLunora.dataModel().create();',
    ])("rejects unsupported or dynamic roots: %s", (setup) => {
        expect.assertions(1);

        const source = project.createSourceFile(join(directory, "dynamic.ts"), `${setup}\nexport const value = base.query(() => 1);`);
        const receiver = source
            .getVariableDeclarationOrThrow("value")
            .getInitializerIfKindOrThrow(SyntaxKind.CallExpression)
            .getExpressionIfKindOrThrow(SyntaxKind.PropertyAccessExpression)
            .getExpression();

        expect(() => lazyMetadataFromBuilderChain(receiver)).toThrow(/resolvable Lunora factory root/u);
    });
});
