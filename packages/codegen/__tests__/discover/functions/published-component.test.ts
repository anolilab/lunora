import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import discoverFunctions from "../../../src/discover/functions";
import { emitApi } from "../../../src/emit/api";
import { emitFunctions } from "../../../src/emit/functions";
import type { FunctionIR } from "../../../src/ir";

// The built `@lunora/server`. Linked into a scratch project, its `definePresence`
// reaches the checker only as `dist/*.d.ts`, the way it does from npm: the
// functions bag has no call literal to resolve back to.
const SERVER_PACKAGE = resolve(import.meta.dirname, "../../../../server");
const VALUES_PACKAGE = resolve(import.meta.dirname, "../../../../values");

let workdir: string;

const discover = (files: Record<string, string>): FunctionIR[] => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    mkdirSync(join(workdir, "node_modules/@lunora"), { recursive: true });
    symlinkSync(SERVER_PACKAGE, join(workdir, "node_modules/@lunora/server"), "dir");
    symlinkSync(VALUES_PACKAGE, join(workdir, "node_modules/@lunora/values"), "dir");
    writeFileSync(
        join(workdir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" }, include: ["lunora"] }),
    );

    for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(workdir, "lunora", name), source);
    }

    return discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath: join(workdir, "tsconfig.json") }), join(workdir, "lunora"));
};

const summary = (functions: FunctionIR[]): Record<string, Pick<FunctionIR, "args" | "kind" | "lifecycle" | "returnType" | "visibility">> =>
    Object.fromEntries(
        functions.map(({ args, exportName, kind, lifecycle, returnType, visibility }) => [
            exportName,
            { args, kind, ...(lifecycle ? { lifecycle } : {}), returnType, visibility },
        ]),
    );

describe("discoverFunctions — a component published as .d.ts", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-published-component-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the documented presence re-export off its declared types", () => {
        expect.assertions(1);

        const found = discover({
            "presence.ts": `import { definePresence } from "@lunora/server";
export const presence = definePresence({ ttlMs: 10_000 });
export const { disconnect, heartbeat, listPresent, sweep } = presence.functions;
`,
        });

        expect(summary(found)).toStrictEqual({
            disconnect: { args: {}, kind: "mutation", lifecycle: "disconnect", returnType: "void", visibility: "internal" },
            heartbeat: {
                args: {
                    data: { inner: { keyType: { kind: "string" }, kind: "record", valueType: { kind: "any" } }, kind: "optional" },
                    roomId: { kind: "string" },
                    sessionId: { kind: "string" },
                },
                kind: "mutation",
                returnType: "{ lastSeen: number; }",
                visibility: "public",
            },
            listPresent: {
                args: { roomId: { kind: "string" } },
                kind: "query",
                returnType: 'import("@lunora/server").PresenceMember[]',
                visibility: "public",
            },
            sweep: {
                args: { roomId: { kind: "string" }, tenantId: { kind: "string" } },
                kind: "mutation",
                returnType: "{ deleted: number; }",
                visibility: "internal",
            },
        });
    });

    it("registers a published function eagerly under lazy functions, and marks its client reference sensitive", () => {
        expect.assertions(3);

        const functions = discover({
            "presence.ts": `import { definePresence } from "@lunora/server";
export const presence = definePresence();
export const { heartbeat } = presence.functions;
`,
        });
        const registry = emitFunctions({ functions, lazyFunctions: true });

        // The type does not say whether the function is paid or carries meta, so no stub may stand in for it.
        expect(registry).toContain('"presence:heartbeat": lunora_presence_0.heartbeat as unknown as RegisteredLunoraFunction');
        expect(registry).not.toContain('"presence:heartbeat": { args: {}, handler: unloadedFunctionHandler');
        // Nor does it say which arguments are `v.sensitive`, so the client keeps them out of the offline queue.
        expect(emitApi({ functions })).toContain('heartbeat: { __lunoraRef: "presence:heartbeat", sensitive: true }');
    });

    it("discovers the property-access form of the same re-export", () => {
        expect.assertions(1);

        const found = discover({
            "presence.ts": `import { definePresence } from "@lunora/server";
const presence = definePresence();
export const heartbeat = presence.functions.heartbeat;
`,
        });

        expect(found.map((entry) => [entry.exportName, entry.kind, entry.visibility])).toStrictEqual([["heartbeat", "mutation", "public"]]);
    });

    it("maps each argument's value type to a real validator kind", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "node_modules/shaped-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/shaped-component/package.json"), JSON.stringify({ name: "shaped-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/shaped-component/index.d.ts"),
            `import type { RegisteredMutation } from "@lunora/server";
import type { Validator } from "@lunora/values";
export declare const functions: {
    save: RegisteredMutation<{
        flags: Validator<boolean[]>;
        mode: Validator<"draft" | "live">;
        note: Validator<string | null>;
        owner: Validator<string & { readonly __brand: "owner" }>;
        point: Validator<{ x: number; label?: string }>;
        pinned: Validator<boolean | undefined>;
    }, void>;
};
`,
        );

        const [save] = discover({
            "shaped.ts": `import { functions } from "shaped-component";
export const { save } = functions;
`,
        });

        expect(save?.args).toStrictEqual({
            flags: { inner: { kind: "boolean" }, kind: "array" },
            mode: {
                kind: "union",
                members: [
                    { kind: "literal", literalValue: '"draft"' },
                    { kind: "literal", literalValue: '"live"' },
                ],
            },
            note: { kind: "union", members: [{ kind: "null" }, { kind: "string" }] },
            owner: { kind: "from", tsType: 'string & { readonly __brand: "owner"; }' },
            pinned: { inner: { kind: "boolean" }, kind: "optional" },
            point: { kind: "object", shape: { label: { inner: { kind: "string" }, kind: "optional" }, x: { kind: "number" } } },
        });
    });

    it("refuses a published function whose type leaves its visibility open", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "node_modules/loose-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/loose-component/package.json"), JSON.stringify({ name: "loose-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/loose-component/index.d.ts"),
            `import type { RegisteredFunction } from "@lunora/server";
export declare const functions: { purge: RegisteredFunction<{}, void, "mutation"> };
`,
        );

        expect(() =>
            discover({
                "loose.ts": `import { functions } from "loose-component";
export const { purge } = functions;
`,
            }),
        ).toThrow(/does not say whether it is internal or public/u);
    });

    it("warns when a component's functions are exported nowhere", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const found = discover({
                "presence.ts": `import { definePresence } from "@lunora/server";
export const presence = definePresence();
`,
            });

            expect(found).toStrictEqual([]);
            expect(warn.mock.calls.map(([message]) => String(message))).toStrictEqual([
                "@lunora/codegen: presence.ts:presence ships functions (disconnect, heartbeat, listPresent, sweep) that nothing re-exports, so none is in the generated api. " +
                    "Add `export const { disconnect, heartbeat, listPresent, sweep } = presence.functions;` (or export your own wrappers of them).",
            ]);
        } finally {
            warn.mockRestore();
        }
    });

    it("stays quiet when another module re-exports the component's functions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const found = discover({
                "collab.ts": `import { presence } from "./presence";
export const { heartbeat } = presence.functions;
`,
                "presence.ts": `import { definePresence } from "@lunora/server";
export const presence = definePresence();
`,
            });

            expect(found.map((entry) => entry.exportName)).toStrictEqual(["heartbeat"]);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("leaves a non-function export of a published component alone", () => {
        expect.assertions(1);

        const found = discover({
            "presence.ts": `import { definePresence } from "@lunora/server";
const presence = definePresence();
export const { extension } = presence;
`,
        });

        expect(found).toStrictEqual([]);
    });
});
