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
 * `sweep` reclaims expired rows across every tenant when called without arguments.
 * It once took one `(tenantId, roomId)` pair, so a cron swept only the app-wide
 * tenant and left every organization's rooms, and every row written before rooms
 * were tenant-scoped, to pile up.
 *
 * Rooms are tenant-scoped from the identity's `orgId` claim. They were once keyed
 * by the client's `roomId` alone, so any member of one organization could join or
 * watch another organization's room by naming it.
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
    sweep: RegisteredMutation<ArgsValidator, { deleted: number }>;
}

let item: PresenceItem;
const open: TestHarness[] = [];

const NOW = 1_700_000_000_000;

const start = (): TestHarness => {
    const t = lunoraTest(defineSchema({ rooms: defineTable({ name: v.string() }) }).extend(item.presence.extension), { now: NOW });

    open.push(t);

    return t;
};

describe("presence registry item", () => {
    beforeAll(async () => {
        mkdirSync(outDirectory, { recursive: true });

        const outfile = join(outDirectory, "presence.mjs");
        const source = readFileSync(join(itemDirectory, "presence.ts"), "utf8");

        if (!source.includes(GENERATED_SERVER)) {
            throw new Error(`registry/presence/presence.ts no longer imports ${GENERATED_SERVER}`);
        }

        // Stage the item next to a stand-in for the generated builder module, then
        // bundle — `@lunora/*` stays external so it resolves to this package's copies.
        writeFileSync(join(outDirectory, "presence.ts"), source.replaceAll(GENERATED_SERVER, "./generated-server.js"));
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

    describe("presence registry item — tenant scoping", () => {
        it("keeps one organization's room invisible to another organization's member", async () => {
            expect.assertions(3);

            const t = start();
            const ada = t.withIdentity({ orgId: "org-a", userId: "ada" });
            const bob = t.withIdentity({ orgId: "org-b", userId: "bob" });
            const eve = t.withIdentity({ userId: "eve" });

            await ada.mutation(item.heartbeat, { data: { name: "Ada" }, roomId: "board", sessionId: "sess-ada" });

            await expect(bob.query(item.listPresent, { roomId: "board" })).resolves.toStrictEqual([]);
            // No `orgId` claim is the app-wide tenant, which holds no organization's rooms.
            await expect(eve.query(item.listPresent, { roomId: "board" })).resolves.toStrictEqual([]);
            await expect(ada.query(item.listPresent, { roomId: "board" })).resolves.toStrictEqual([
                expect.objectContaining({ roomId: "board", sessionId: "sess-ada", userId: "ada" }),
            ]);
        });

        it("files another organization's heartbeat under its own tenant, leaving the first room untouched", async () => {
            expect.assertions(2);

            const t = start();
            const ada = t.withIdentity({ orgId: "org-a", userId: "ada" });
            const bob = t.withIdentity({ orgId: "org-b", userId: "bob" });

            await ada.mutation(item.heartbeat, { data: { name: "Ada" }, roomId: "board", sessionId: "sess-ada" });
            // Same room name, same visible session id: lands in org-b's room, not on Ada's row.
            await bob.mutation(item.heartbeat, { data: { name: "Bob" }, roomId: "board", sessionId: "sess-ada" });

            await expect(ada.query(item.listPresent, { roomId: "board" })).resolves.toStrictEqual([
                expect.objectContaining({ data: { name: "Ada" }, sessionId: "sess-ada", userId: "ada" }),
            ]);
            await expect(bob.query(item.listPresent, { roomId: "board" })).resolves.toStrictEqual([
                expect.objectContaining({ data: { name: "Bob" }, sessionId: "sess-ada", userId: "bob" }),
            ]);
        });

        it("reclaims only the joining tenant's expired rows, never another organization's", async () => {
            expect.assertions(1);

            const t = start();
            const ada = t.withIdentity({ orgId: "org-a", userId: "ada" });

            await t.run(async (ctx) => {
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-a", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-b", tenantId: "org-b" });
            });

            await ada.mutation(item.heartbeat, { roomId: "board", sessionId: "sess-ada" });

            const left = await t.run(async (ctx) => {
                const rows = await ctx.db.query("presence_present").collect();

                return rows.map((row) => `${String(row["tenantId"])}/${String(row["sessionId"])}`).toSorted((a, b) => a.localeCompare(b));
            });

            expect(left).toStrictEqual(["org-a/sess-ada", "org-b/gone-b"]);
        });
    });

    describe("presence registry item — sweep", () => {
        // Internal, so it runs the way a cron dispatches it: from the server, not the RPC boundary.
        const sweep = async (t: TestHarness, args: Record<string, unknown>): Promise<unknown> => t.run(async (ctx) => ctx.runMutation(item.sweep, args));

        /** `tenant/session` of every stored row, sorted; `-` marks a row without a tenant. */
        const remaining = async (t: TestHarness): Promise<string[]> =>
            t.run(async (ctx) => {
                const rows = await ctx.db.query("presence_present").collect();

                return rows
                    .map((row) => `${typeof row["tenantId"] === "string" ? row["tenantId"] : "-"}/${String(row["sessionId"])}`)
                    .toSorted((a, b) => a.localeCompare(b));
            });

        it("reclaims expired rows of every tenant, and rows written before rooms were tenant-scoped, when given no arguments", async () => {
            expect.assertions(2);

            // A row written before rooms were tenant-scoped has no `tenantId`; the
            // schema must still accept it, or the deploy's drift gate blocks the upgrade.
            const legacy = start();

            await legacy.run(async (ctx) => {
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-a", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-b", tenantId: "org-b" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-app", tenantId: "" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-legacy" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "board", sessionId: "live-a", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "lobby", sessionId: "live-b", tenantId: "org-b" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "lobby", sessionId: "live-legacy" });
            });

            await expect(sweep(legacy, {})).resolves.toStrictEqual({ deleted: 4 });
            await expect(remaining(legacy)).resolves.toStrictEqual(["-/live-legacy", "org-a/live-a", "org-b/live-b"]);
        });

        it("keeps a row without a tenant out of the app-wide tenant's room", async () => {
            expect.assertions(1);

            const t = start();

            await t.run(async (ctx) => {
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "lobby", sessionId: "legacy" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "lobby", sessionId: "app", tenantId: "" });
            });

            await expect(t.withIdentity({ userId: "eve" }).query(item.listPresent, { roomId: "lobby" })).resolves.toStrictEqual([
                expect.objectContaining({ sessionId: "app" }),
            ]);
        });

        it("sweeps only the named tenant's room when given a (tenantId, roomId) pair", async () => {
            expect.assertions(2);

            const t = start();

            await t.run(async (ctx) => {
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-a", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-a-lobby", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-b", tenantId: "org-b" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-app", tenantId: "" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "board", sessionId: "live-a", tenantId: "org-a" });
            });

            await expect(sweep(t, { roomId: "board", tenantId: "org-a" })).resolves.toStrictEqual({ deleted: 1 });
            await expect(remaining(t)).resolves.toStrictEqual(["/gone-app", "org-a/gone-a-lobby", "org-a/live-a", "org-b/gone-b"]);
        });

        it("sweeps a room in every tenant when given only its roomId, the shape crons written before tenant scoping pass", async () => {
            expect.assertions(2);

            const t = start();

            await t.run(async (ctx) => {
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-a", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-b", tenantId: "org-b" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "lobby", sessionId: "gone-legacy" });
                await ctx.db.insert("presence_present", { lastSeen: 0, roomId: "board", sessionId: "gone-a-board", tenantId: "org-a" });
                await ctx.db.insert("presence_present", { lastSeen: NOW, roomId: "lobby", sessionId: "live-b", tenantId: "org-b" });
            });

            await expect(sweep(t, { roomId: "lobby" })).resolves.toStrictEqual({ deleted: 3 });
            await expect(remaining(t)).resolves.toStrictEqual(["org-a/gone-a-board", "org-b/live-b"]);
        });

        it("refuses a tenant without a room rather than guessing which rows it means", async () => {
            expect.assertions(1);

            await expect(sweep(start(), { tenantId: "org-a" })).rejects.toThrow(/a tenantId needs its roomId/u);
        });
    });
});
