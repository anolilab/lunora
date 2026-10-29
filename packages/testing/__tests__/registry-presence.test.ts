import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ArgsValidator, RegisteredMutation, RegisteredQuery } from "@lunora/server";
import { defineSchema, defineTable, v } from "@lunora/server";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TestHarness } from "../src/index";
import { lunoraTest } from "../src/index";

/**
 * The `presence` registry item's public `heartbeat`, run as a scaffolded app
 * would run it.
 *
 * `listPresent` re-sends every member's `data` to every room subscriber on each
 * heartbeat, so the item has to bound the record as a whole — keys, entry count,
 * total size — not just each value. It once bounded only the values, which let an
 * anonymous caller store about 1 MiB of awareness data per session.
 *
 * The item imports its builders from `#lunora/_generated/server.js`, a module only
 * codegen writes, so the test bundles the item with that specifier pointed at the
 * base `@lunora/server` builders. Everything else is the shipped file.
 */

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → packages/testing → packages → repo root → registry/presence
const itemDirectory = resolve(here, "..", "..", "..", "registry", "presence");
const GENERATED_SERVER = "#lunora/_generated/server.js";
// Inside the package so the bundle's bare `@lunora/*` imports resolve to the same
// instances this test imports.
const outDirectory = join(here, "..", "node_modules", ".registry-presence-test");

interface PresenceItem {
    heartbeat: RegisteredMutation<ArgsValidator, unknown>;
    listPresent: RegisteredQuery<ArgsValidator, unknown>;
    presence: { extension: Parameters<ReturnType<typeof defineSchema>["extend"]>[0] };
}

let item: PresenceItem;
const open: TestHarness[] = [];

const start = (): TestHarness => {
    const t = lunoraTest(defineSchema({ rooms: defineTable({ name: v.string() }) }).extend(item.presence.extension));

    open.push(t);

    return t;
};

describe("presence registry item — heartbeat payload bounds", () => {
    beforeAll(async () => {
        mkdirSync(outDirectory, { recursive: true });

        const outfile = join(outDirectory, "presence.mjs");
        const source = readFileSync(join(itemDirectory, "presence.ts"), "utf8");

        if (!source.includes(GENERATED_SERVER)) {
            throw new Error(`registry/presence/presence.ts no longer imports ${GENERATED_SERVER}`);
        }

        // Stage the item next to a stand-in for the generated builder module, then
        // bundle — `@lunora/*` stays external so it resolves to this package's copies.
        writeFileSync(join(outDirectory, "presence.ts"), source.replace(GENERATED_SERVER, "./generated-server.js"));
        copyFileSync(join(itemDirectory, "schema.ts"), join(outDirectory, "schema.ts"));
        writeFileSync(
            join(outDirectory, "generated-server.ts"),
            `import { initLunora, v } from "@lunora/server";
export const { internalMutation, mutation, query } = initLunora.dataModel().create();
export { v };`,
        );

        await build({
            bundle: true,
            entryPoints: [join(outDirectory, "presence.ts")],
            external: ["@lunora/*"],
            format: "esm",
            outfile,
            platform: "node",
        });

        writeFileSync(join(outDirectory, "package.json"), `{ "type": "module" }`);

        item = (await import(pathToFileURL(outfile).href)) as PresenceItem;
    });

    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    afterAll(() => {
        rmSync(outDirectory, { force: true, recursive: true });
    });

    it("accepts a normal awareness payload and returns it from listPresent", async () => {
        expect.assertions(1);

        const t = start();
        const data = { color: "#ff0000", cursor: 42, name: "Ada", typing: true };

        await t.mutation(item.heartbeat, { data, roomId: "room-1", sessionId: "sess-1" });

        await expect(t.query(item.listPresent, { roomId: "room-1" })).resolves.toStrictEqual([
            expect.objectContaining({ data, roomId: "room-1", sessionId: "sess-1" }),
        ]);
    });

    it("refuses a payload with too many entries", async () => {
        expect.assertions(2);

        const t = start();
        const data = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${String(index)}`, index]));

        await expect(t.mutation(item.heartbeat, { data, roomId: "room-1", sessionId: "sess-1" })).rejects.toThrow(/data has 1000 entries/u);
        await expect(t.query(item.listPresent, { roomId: "room-1" })).resolves.toStrictEqual([]);
    });

    it("refuses a payload whose total size is over the cap even when every value is in bounds", async () => {
        expect.assertions(1);

        const t = start();
        // 8 entries × 1 KiB values: each value passes `.max(1024)`, the record does not.
        const data = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${String(index)}`, "x".repeat(1024)]));

        await expect(t.mutation(item.heartbeat, { data, roomId: "room-1", sessionId: "sess-1" })).rejects.toThrow(/bytes; the limit is/u);
    });

    it("refuses an over-long key", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.mutation(item.heartbeat, { data: { ["k".repeat(65)]: 1 }, roomId: "room-1", sessionId: "sess-1" })).rejects.toThrow(
            /expected string length <= 64/u,
        );
    });
});
