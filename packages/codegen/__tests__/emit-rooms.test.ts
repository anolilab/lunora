import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";

import { emitApi, emitFunctions, emitShard } from "../src/emit";
import type { FunctionIR } from "../src/ir";

/**
 * The generated half of `defineRoom`: the `LUNORA_ROOMS` topic→path registry
 * and the ShardDO `roomHandlerPath` override that resolves a room whisper topic
 * through it. Both are gated on a declared room so a room-free project's output
 * is byte-identical.
 */
const roomFunction: FunctionIR = {
    args: {},
    exportName: "chat",
    filePath: "rooms",
    channel: { kind: "room", name: "chat" },
    kind: "mutation",
    returnType: "void",
    visibility: "internal",
};

describe("emitShard — roomHandlerPath override", () => {
    it("resolves a room topic through the generated LUNORA_ROOMS map", () => {
        expect.assertions(3);

        const emitted = emitShard({ hasRooms: true, schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).toContain("protected override roomHandlerPath(topic: string): string | undefined {");
        // Own properties only: an inherited name such as `toString` is not a room.
        expect(emitted).toContain("return Object.hasOwn(LUNORA_ROOMS, topic) ? LUNORA_ROOMS[topic] : undefined;");
        // The registry is imported from the generated functions module.
        expect(emitted).toMatch(/import \{[^}]*LUNORA_ROOMS[^}]*\} from "\.\/functions\.js";/u);
    });

    it("omits the override when no room is declared, so the base default applies", () => {
        expect.assertions(2);

        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).not.toContain("roomHandlerPath");
        expect(emitted).not.toContain("LUNORA_ROOMS");
    });
});

describe("emitFunctions — LUNORA_ROOMS registry", () => {
    it("keys the registry on the room's whisper topic", () => {
        expect.assertions(3);

        const emitted = emitFunctions({ functions: [roomFunction] });

        expect(emitted).toContain("export const LUNORA_ROOMS: Readonly<Record<string, string>>");
        // The key is the SAME `room:<name>` topic the client subscribes on
        // (asserted in two parts so the `${…}` inside a template literal does not
        // trip `no-template-curly-in-string` on a string that is only inspected).
        expect(emitted).toContain("`room:");
        expect(emitted).toContain("registry[topic] = path;");
    });

    it("makes the generated registry refuse two defineRoom registrations under one name", () => {
        expect.assertions(2);

        // The collision is detected when the generated registry loads: the room
        // name only exists on the registered objects, not in the codegen IR.
        const emitted = emitFunctions({ functions: [roomFunction] });

        expect(emitted).toContain("room names must be unique");
        expect(emitted).toContain("if (owner !== undefined && owner !== fn) {");
    });

    it("types each room's message from its own registration", () => {
        expect.assertions(2);

        const emitted = emitFunctions({ functions: [roomFunction] });

        expect(emitted).toContain('import type { RoomMessageOf } from "@lunora/server";');
        expect(emitted).toContain('"chat": RoomMessageOf<typeof lunora_rooms_0["chat"]>;');
    });

    it("runs the emitted registry: each room topic maps to its path, an alias is one room, and a clash throws", () => {
        expect.assertions(3);

        // Evaluate the emitted block, not a string match on it: transpile the registry
        // and run it against a stubbed function table.
        const emitted = emitFunctions({ functions: [roomFunction] });
        const start = emitted.indexOf("export const LUNORA_ROOMS");
        const block = emitted.slice(start, emitted.indexOf("})();", start) + "})();".length);
        const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const registryOf = (functions: Record<string, unknown>): unknown => {
            const exported: Record<string, unknown> = {};

            // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- the test runs the emitted registry it just transpiled
            new Function("LUNORA_FUNCTIONS", "exports", js)(functions, exported);

            return exported["LUNORA_ROOMS"];
        };
        const room = { channel: { kind: "room", name: "chat" } };

        expect(registryOf({ "rooms:chat": room })).toStrictEqual({ "room:chat": "rooms:chat" });
        // An alias: one registration exported under two names is one room, not a clash.
        expect(registryOf({ "rooms:chat": room, "rooms:lobby": room })).toStrictEqual({ "room:chat": "rooms:chat" });
        // Two distinct registrations under one name are a real clash.
        expect(() => registryOf({ "rooms:a": { channel: { kind: "room", name: "chat" } }, "rooms:b": { channel: { kind: "room", name: "chat" } } })).toThrow(
            /room names must be unique/u,
        );
    });

    it("runs the emitted api module: the rooms reference addresses each room by its name", () => {
        expect.assertions(2);

        // The api module's only value output is the references, so transpiling it and
        // running it yields the `rooms` object a client would import.
        const emitted = emitApi({ functions: [roomFunction] });
        const js = ts.transpileModule(emitted, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exported: Record<string, unknown> = {};

        // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- the test runs the emitted api module it just transpiled
        new Function("exports", "require", js)(exported, () => {
            return {};
        });

        expect(exported["rooms"]).toStrictEqual({ chat: { name: "chat" } });
        expect(emitted).toContain('chat: RoomRef<LunoraRoomMessages["chat"]>;');
    });

    it("keeps the registry out of a room-free project", () => {
        expect.assertions(4);

        // The interface docblock names the map, so assert on the EXPORT, not the
        // bare token — the emitted registry itself must be absent. The room-only
        // interface field and the message types must be absent too, so an app with no
        // rooms emits what it always did.
        const emitted = emitFunctions({ functions: [] });

        expect(emitted).not.toContain("export const LUNORA_ROOMS");
        expect(emitted).not.toContain("channel?:");
        expect(emitted).not.toContain("LunoraRoomMessages");
        expect(emitted).not.toContain("RoomMessageOf");
    });
});
