import { describe, expect, it } from "vitest";

import { emitFunctions, emitShard } from "../src/emit";
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
    kind: "mutation",
    lifecycle: "room",
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
        expect(emitted).toContain("if (topic in registry) {");
    });

    it("keeps the registry out of a room-free project", () => {
        expect.assertions(1);

        // The interface docblock names the map, so assert on the EXPORT, not the
        // bare token — the emitted registry itself must be absent.
        expect(emitFunctions({ functions: [] })).not.toContain("export const LUNORA_ROOMS");
    });
});
