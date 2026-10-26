import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { constructsEventLogClient, forwardsReplicaExport, parseModule, resolveBarrel, runtimeSpecifiersOf } from "../src/replica-export-graph";

describe("replica export graph", () => {
    let root: string;

    const write = (relativePath: string, code: string): string => {
        const file = join(root, relativePath);

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, code);

        return file;
    };

    const hostsLog = (entry: string): boolean => forwardsReplicaExport(entry, "EventLogDO", undefined, new Set());

    const constructsClient = (code: string): boolean =>
        constructsEventLogClient(new Project({ skipAddingFilesFromTsConfig: true }).createSourceFile(join(root, "src/file.ts"), code, { overwrite: true }));

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-export-graph-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(forwardsReplicaExport, () => {
        it("follows a named re-export through a .js-specified barrel to its .ts source", () => {
            expect.assertions(1);

            const entry = write("src/index.ts", `export * from "./barrel.js";\n`);

            write("src/barrel.ts", `export { EventLogDO } from "@lunora/replica";\n`);

            expect(hostsLog(entry)).toBe(true);
        });

        it("asks a barrel for the name a rename reads, and rejects a rename of another export", () => {
            expect.assertions(2);

            write("src/barrel.ts", `export { EventLogDO as Log, Other } from "@lunora/replica";\n`);

            expect(hostsLog(write("src/renamed.ts", `export { Log as EventLogDO } from "./barrel";\n`))).toBe(true);
            expect(hostsLog(write("src/other.ts", `export { Other as EventLogDO } from "./barrel";\n`))).toBe(false);
        });

        it("counts a value alias, a namespace property and a subclass of the imported class", () => {
            expect.assertions(3);

            expect(hostsLog(write("src/alias.ts", `import { EventLogDO } from "@lunora/replica";\nexport const Log = EventLogDO;\n`))).toBe(true);
            expect(hostsLog(write("src/namespace.ts", `import * as replica from "@lunora/replica";\nexport const Log = replica.EventLogDO;\n`))).toBe(true);
            expect(hostsLog(write("src/subclass.ts", `import { EventLogDO } from "@lunora/replica";\nexport class Log extends EventLogDO {}\n`))).toBe(true);
        });

        it("lets a local export shadow the star re-export of the same name, in the module or an outer one", () => {
            expect.assertions(2);

            expect(hostsLog(write("src/own.ts", `export class EventLogDO {}\nexport * from "@lunora/replica";\n`))).toBe(false);

            write("src/inner.ts", `export * from "@lunora/replica";\n`);

            expect(hostsLog(write("src/outer.ts", `export class EventLogDO {}\nexport * from "./inner";\n`))).toBe(false);
        });

        it("forwards nothing through a type-only re-export and ends a barrel cycle", () => {
            expect.assertions(2);

            expect(hostsLog(write("src/types.ts", `export type { EventLogDO } from "@lunora/replica";\n`))).toBe(false);

            write("src/a.ts", `export * from "./b";\n`);
            write("src/b.ts", `export * from "./a";\n`);

            expect(hostsLog(join(root, "src/a.ts"))).toBe(false);
        });
    });

    describe(constructsEventLogClient, () => {
        it("counts a value import of the client and ignores a type-only one", () => {
            expect.assertions(2);

            expect(constructsClient(`import { EventLogDOClient } from "@lunora/replica";\n`)).toBe(true);
            expect(constructsClient(`import type { EventLogDOClient } from "@lunora/replica";\n`)).toBe(false);
        });

        it("counts a namespace read of the client but not of another export or a type position", () => {
            expect.assertions(3);

            expect(constructsClient(`import * as r from "@lunora/replica";\nnew r.EventLogDOClient();\n`)).toBe(true);
            expect(constructsClient(`import * as r from "@lunora/replica";\nexport const Log = r.EventLogDO;\n`)).toBe(false);
            expect(constructsClient(`import * as r from "@lunora/replica";\nlet c: r.EventLogDOClient;\n`)).toBe(false);
        });

        it("reads an awaited dynamic import by what it destructures", () => {
            expect.assertions(2);

            expect(constructsClient(`const { EventLogDOClient } = await import("@lunora/replica");\n`)).toBe(true);
            expect(constructsClient(`const { EventLogDO } = await import("@lunora/replica");\n`)).toBe(false);
        });

        it("follows a relative barrel that forwards the client", () => {
            expect.assertions(1);

            write("src/barrel.ts", `export * from "@lunora/replica";\n`);

            expect(constructsClient(`import { EventLogDOClient } from "./barrel";\n`)).toBe(true);
        });
    });

    describe(resolveBarrel, () => {
        it("resolves a directory index and never reads the replica package as a file", () => {
            expect.assertions(2);

            const from = write("src/index.ts", "");
            const index = write("src/lib/index.ts", "");

            expect(resolveBarrel(from, "./lib")).toBe(index);
            expect(resolveBarrel(from, "@lunora/replica")).toBeUndefined();
        });

        it("resolves a tsconfig paths alias the way the project's TypeScript does", () => {
            expect.assertions(1);

            write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }));

            const from = write("src/index.ts", "");
            const target = write("src/barrel.ts", "");

            expect(resolveBarrel(from, "~/barrel")).toBe(target);
        });
    });

    describe(runtimeSpecifiersOf, () => {
        it("lists static imports, re-exports and literal dynamic imports, skipping type-only declarations", () => {
            expect.assertions(1);

            const file = write(
                "src/index.ts",
                `import a from "./a";\nimport type { B } from "./b";\nexport * from "./c";\nexport type { D } from "./d";\nawait import("./e");\n`,
            );

            expect(runtimeSpecifiersOf(parseModule(file))).toStrictEqual(["./a", "./c", "./e"]);
        });
    });
});
