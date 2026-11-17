import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;

interface OpenRpcMethod {
    name: string;
    "x-lunora-description"?: string;
}

const openRpcMethods = (): OpenRpcMethod[] => {
    const document = JSON.parse(readFileSync(join(workdir, "lunora", "_generated", "openrpc.json"), "utf8")) as { methods: OpenRpcMethod[] };

    return document.methods;
};

const methodNamed = (name: string): OpenRpcMethod | undefined => openRpcMethods().find((method) => method.name === name);

describe("doc comments on a registration", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-openrpc-description-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(
            join(workdir, "lunora", "notes.ts"),
            `import { mutation, query } from "@lunora/server";

/**
 * Lists the notes in a folder, newest first.
 *
 * @example list()
 */
export const list = query({ args: {}, handler: async () => [] });

export const remove = mutation({ args: {}, handler: async () => {} });
`,
            "utf8",
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("carries the doc comment into the OpenRPC method, without its tags", () => {
        expect.assertions(1);

        runCodegen({ apiSpec: "openrpc", projectRoot: workdir, wranglerQueueProducers: [] });

        expect(methodNamed("notes:list")?.["x-lunora-description"]).toBe("Lists the notes in a folder, newest first.");
    });

    it("describes a re-exported registration by the comment on its export, not the bundle it was declared in", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "reexport.ts"),
            `import { query } from "@lunora/server";

/** The bundle's comment, which the export does not carry. */
const bundle = { list: query({ args: {}, handler: async () => [] }) };

/** The exported comment. */
export const list = bundle.list;
`,
            "utf8",
        );

        runCodegen({ apiSpec: "openrpc", projectRoot: workdir, wranglerQueueProducers: [] });

        expect(methodNamed("reexport:list")?.["x-lunora-description"]).toBe("The exported comment.");
    });

    it("omits the extension for a registration with no doc comment", () => {
        expect.assertions(2);

        runCodegen({ apiSpec: "openrpc", projectRoot: workdir, wranglerQueueProducers: [] });

        expect(methodNamed("notes:remove")).toBeDefined();
        expect(methodNamed("notes:remove")).not.toHaveProperty("x-lunora-description");
    });
});
