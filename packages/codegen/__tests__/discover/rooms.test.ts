import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../../src/discover/functions/index";

/**
 * Room discovery: the room's name is read off the `defineRoom` call at build time,
 * because a computed name cannot be typed into a client reference or checked for
 * duplicates. A registration is found by its import of `@lunora/server`.
 */
let workdir: string;

const writeLunoraSource = (relative: string, source: string): void => {
    const full = join(workdir, "lunora", relative);

    mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
    writeFileSync(full, source);
};

const discover = () => discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true }), join(workdir, "lunora"));

describe("discover/functions — defineRoom channels", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rooms-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the room's literal name into its channel", () => {
        expect.assertions(2);

        writeLunoraSource(
            "rooms.ts",
            `import { defineRoom, v } from "@lunora/server";
export const chat = defineRoom({ name: "chat", message: v.object({ text: v.string() }), onMessage: () => undefined });`,
        );

        const [room] = discover();

        expect(room?.channel).toStrictEqual({ kind: "room", name: "chat" });
        // A channel registration is not a lifecycle hook.
        expect(room?.lifecycle).toBeUndefined();
    });

    it("reads a room registered through a namespace import, not only a named one", () => {
        expect.assertions(1);

        writeLunoraSource(
            "rooms.ts",
            `import * as lunora from "@lunora/server";
export const chat = lunora.defineRoom({ name: "chat", message: lunora.v.object({ text: lunora.v.string() }), onMessage: () => undefined });`,
        );

        const [room] = discover();

        expect(room?.channel).toStrictEqual({ kind: "room", name: "chat" });
    });

    it("refuses two separate defineRoom calls under one name in the same file", () => {
        expect.assertions(1);

        writeLunoraSource(
            "rooms.ts",
            `import { defineRoom, v } from "@lunora/server";
export const chatA = defineRoom({ name: "chat", message: v.object({}), onMessage: () => undefined });
export const chatB = defineRoom({ name: "chat", message: v.object({}), onMessage: () => undefined });`,
        );

        expect(() => discover()).toThrow(/Duplicate room name "chat"/u);
    });

    it("reads a room registered through the umbrella package's namespace import", () => {
        expect.assertions(1);

        writeLunoraSource(
            "rooms.ts",
            `import * as lunora from "lunorash/server";
export const chat = lunora.defineRoom({ name: "chat", message: lunora.v.object({ text: lunora.v.string() }), onMessage: () => undefined });`,
        );

        const [room] = discover();

        expect(room?.channel).toStrictEqual({ kind: "room", name: "chat" });
    });

    it("ignores a defineRoom method on an object that is not the @lunora/server import", () => {
        expect.assertions(1);

        writeLunoraSource(
            "other.ts",
            `const kit = { defineRoom: (options: { name: string }) => options };
export const notARoom = kit.defineRoom({ name: "chat" });`,
        );

        expect(discover().filter((definition) => definition.channel !== undefined)).toStrictEqual([]);
    });

    it("refuses a computed room name, which codegen could neither type nor deduplicate", () => {
        expect.assertions(1);

        writeLunoraSource(
            "rooms.ts",
            `import { defineRoom, v } from "@lunora/server";
const name = "chat";
export const chat = defineRoom({ name, message: v.object({}), onMessage: () => undefined });`,
        );

        expect(() => discover()).toThrow(/string-literal `name`/u);
    });

    it("refuses two rooms under one name, naming both files", () => {
        expect.assertions(1);

        writeLunoraSource(
            "a.ts",
            `import { defineRoom, v } from "@lunora/server";
export const chatA = defineRoom({ name: "chat", message: v.object({}), onMessage: () => undefined });`,
        );
        writeLunoraSource(
            "b.ts",
            `import { defineRoom, v } from "@lunora/server";
export const chatB = defineRoom({ name: "chat", message: v.object({}), onMessage: () => undefined });`,
        );

        expect(() => discover()).toThrow(/Duplicate room name "chat"/u);
    });

    it("accepts one room exported under two names in the same module as an alias", () => {
        expect.assertions(1);

        writeLunoraSource(
            "chat.ts",
            `import { defineRoom, v } from "@lunora/server";
export const chat = defineRoom({ name: "chat", message: v.object({}), onMessage: () => undefined });
export const lobby = chat;`,
        );

        // Both exports are one registration: discovery does not clash on them.
        expect(() => discover()).not.toThrow();
    });
});
