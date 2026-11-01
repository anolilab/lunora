import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import discoverFunctions from "../../../src/discover/functions";
import { warnUnwiredComponents } from "../../../src/discover/functions/internal/registered-type";
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

    const project = new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath: join(workdir, "tsconfig.json") });
    const functions = discoverFunctions(project, join(workdir, "lunora"));

    // What `run-codegen` does once after discovery.
    warnUnwiredComponents(
        Object.keys(files).map((name) => project.getSourceFileOrThrow(join(workdir, "lunora", name))),
        (source) => relative(join(workdir, "lunora"), source.getFilePath()),
    );

    return functions;
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
        blob: Validator<ArrayBuffer>;
        at: Validator<Date>;
        flags: Validator<boolean[]>;
        mode: Validator<"draft" | "live">;
        note: Validator<string | null>;
        note_id: Validator<string & { readonly __table: "notes" }>;
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
            at: { kind: "from", tsType: "Date" },
            blob: { kind: "bytes" },
            flags: { inner: { kind: "boolean" }, kind: "array" },
            mode: {
                kind: "union",
                members: [
                    { kind: "literal", literalValue: '"draft"' },
                    { kind: "literal", literalValue: '"live"' },
                ],
            },
            note: { kind: "union", members: [{ kind: "null" }, { kind: "string" }] },
            note_id: { kind: "id", tableName: "notes" },
            owner: { kind: "from", tsType: 'string & { readonly __brand: "owner"; }' },
            pinned: { inner: { kind: "boolean" }, kind: "optional" },
            point: { kind: "object", shape: { label: { inner: { kind: "string" }, kind: "optional" }, x: { kind: "number" } } },
        });
    });

    it("discovers a published stream with its chunk type", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "node_modules/stream-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/stream-component/package.json"), JSON.stringify({ name: "stream-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/stream-component/index.d.ts"),
            `import type { RegisteredStream } from "@lunora/server";
import type { Validator } from "@lunora/values";
export declare const functions: {
    ticks: RegisteredStream<{ roomId: Validator<string> }, { at: number }>;
    audit: RegisteredStream<{}, string, "internal">;
};
`,
        );

        expect(
            summary(
                discover({
                    "ticker.ts": `import { functions } from "stream-component";
export const { audit, ticks } = functions;
`,
                }),
            ),
        ).toStrictEqual({
            audit: { args: {}, kind: "stream", returnType: "string", visibility: "internal" },
            ticks: { args: { roomId: { kind: "string" } }, kind: "stream", returnType: "{ at: number; }", visibility: "public" },
        });
    });

    const installArgless = (): void => {
        mkdirSync(join(workdir, "node_modules/argless-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/argless-component/package.json"), JSON.stringify({ name: "argless-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/argless-component/index.d.ts"),
            `import type { RegisteredMutation } from "@lunora/server";
import type { Validator } from "@lunora/values";
export declare const functions: { ping: RegisteredMutation<{}, void>; open: RegisteredMutation<Record<string, Validator>, void> };
`,
        );
    };

    it("exempts an argument-free published function from the sensitive marking", () => {
        expect.assertions(1);

        installArgless();

        const ping = discover({ "ping.ts": `import { functions } from "argless-component";\nexport const { ping } = functions;\n` });

        // Nothing to leak, so the client may queue it offline.
        expect(emitApi({ functions: ping })).toContain('ping: { __lunoraRef: "ping:ping" }');
    });

    it("refuses a published function whose args type does not list its keys", () => {
        expect.assertions(1);

        installArgless();

        expect(() => discover({ "open.ts": `import { functions } from "argless-component";\nexport const { open } = functions;\n` })).toThrow(
            /does not list its arguments/u,
        );
    });

    it("routes a published hook by the moment its factory returns, and names the fix for one that hides it", () => {
        expect.assertions(2);

        mkdirSync(join(workdir, "node_modules/hook-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/hook-component/package.json"), JSON.stringify({ name: "hook-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/hook-component/index.d.ts"),
            `import type { onConnect, RegisteredLifecycleHook } from "@lunora/server";
export declare const functions: { join: ReturnType<typeof onConnect>; leave: RegisteredLifecycleHook };
`,
        );

        expect(summary(discover({ "hooks.ts": `import { functions } from "hook-component";\nexport const { join } = functions;\n` }))).toStrictEqual({
            join: { args: {}, kind: "mutation", lifecycle: "connect", returnType: "void", visibility: "internal" },
        });

        rmSync(join(workdir, "lunora"), { force: true, recursive: true });
        rmSync(join(workdir, "node_modules/@lunora"), { force: true, recursive: true });

        expect(() => discover({ "hooks.ts": `import { functions } from "hook-component";\nexport const { leave } = functions;\n` })).toThrow(
            /does not say which moment it runs at/u,
        );
    });

    it("renders an async handler's awaited result, as dispatch returns it", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "node_modules/async-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/async-component/package.json"), JSON.stringify({ name: "async-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/async-component/index.d.ts"),
            `export declare const functions: {
    load: { readonly args: {}; readonly handler: (context: unknown, args: {}) => Promise<{ ready: boolean }>; readonly kind: "query"; readonly visibility?: "public" };
};
`,
        );

        expect(discover({ "load.ts": `import { functions } from "async-component";\nexport const { load } = functions;\n` })[0]?.returnType).toBe(
            "{ ready: boolean; }",
        );
    });

    it("refuses a published room with advice that fits a room", () => {
        expect.assertions(1);

        mkdirSync(join(workdir, "node_modules/room-component"), { recursive: true });
        writeFileSync(join(workdir, "node_modules/room-component/package.json"), JSON.stringify({ name: "room-component", types: "index.d.ts" }));
        writeFileSync(
            join(workdir, "node_modules/room-component/index.d.ts"),
            `import type { RegisteredRoom } from "@lunora/server";
export declare const functions: { lobby: RegisteredRoom<{ text: string }> };
`,
        );

        expect(() => discover({ "rooms.ts": `import { functions } from "room-component";\nexport const { lobby } = functions;\n` })).toThrow(
            /re-exports a room from a published package/u,
        );
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

    it("stays quiet when another module reads the component's functions, in any form", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const found = discover({
                "collab.ts": `import { presence } from "./presence";
export const { heartbeat } = presence.functions;
`,
                "rooms.ts": `import { roomPresence } from "./presence";
const { functions } = roomPresence;
export const listPresent = functions.listPresent;
`,
                "sweeper.ts": `import { sweepPresence } from "./presence";
export const sweep = sweepPresence["functions"].sweep;
`,
                "presence.ts": `import { definePresence } from "@lunora/server";
export const presence = definePresence();
export const roomPresence = definePresence();
export const sweepPresence = definePresence();
`,
            });

            expect(found.map((entry) => entry.exportName)).toStrictEqual(["heartbeat", "listPresent", "sweep"]);
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
