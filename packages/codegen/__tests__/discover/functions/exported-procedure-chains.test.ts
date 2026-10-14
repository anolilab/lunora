/**
 * The shared builder-chain collector the mask and RLS metadata feeders walk.
 *
 * It was previously two copies, one per feeder, that had drifted: the mask copy
 * returned bare receivers and the RLS copy returned `{ name, receiver }`. They
 * are one function now, so the name every caller can rely on — and the
 * exclusions both always depended on — are pinned here rather than implicitly
 * in whichever feeder happened to exercise them.
 */
import { Project } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import exportedProcedureChains from "../../../src/discover/functions/exported-procedure-chains";

let project: Project;

const sourceOf = (body: string) => project.createSourceFile("messages.ts", `import { query, mutation } from "@lunora/server";\n${body}`, { overwrite: true });

describe("exportedProcedureChains", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("returns each exported builder chain with its declaration name", () => {
        expect.assertions(2);

        const chains = exportedProcedureChains(
            sourceOf(`
                export const list = query.use(rls(policies)).query(async (ctx) => []);
                export const send = mutation.use(mask(columns)).mutation(async (ctx) => null);
            `),
        );

        expect(chains.map((chain) => chain.name)).toStrictEqual(["list", "send"]);
        // The receiver is the chain root the caller walks for `.use(...)` steps.
        expect(chains.map((chain) => chain.receiver.getText())).toStrictEqual(["query.use(rls(policies))", "mutation.use(mask(columns))"]);
    });

    it("skips the bare-factory form, which has no chain to walk", () => {
        expect.assertions(1);

        // `query({...})` classifies as a procedure but carries no receiver, so
        // there is no `.use(...)` step any caller could inspect.
        expect(exportedProcedureChains(sourceOf(`export const list = query({ args: {}, handler: async (ctx) => [] });`))).toStrictEqual([]);
    });

    it("skips declarations that are not exported", () => {
        expect.assertions(1);

        const chains = exportedProcedureChains(
            sourceOf(`
                const internalOnly = query.use(rls(p)).query(async (ctx) => []);
                export const exposed = query.use(rls(p)).query(async (ctx) => []);
            `),
        );

        expect(chains.map((chain) => chain.name)).toStrictEqual(["exposed"]);
    });

    it("skips exports whose initializer is not a procedure call", () => {
        expect.assertions(1);

        expect(
            exportedProcedureChains(
                sourceOf(`
                    export const limit = 25;
                    export const helper = someOther.builder().query(async () => []);
                    export const uninitialized: unknown = undefined;
                `),
            ),
        ).toStrictEqual([]);
    });

    it("names every declaration in a multi-declaration export statement", () => {
        expect.assertions(1);

        const chains = exportedProcedureChains(
            sourceOf(`export const first = query.use(rls(p)).query(async () => []), second = query.use(rls(p)).query(async () => []);`),
        );

        expect(chains.map((chain) => chain.name)).toStrictEqual(["first", "second"]);
    });
});
