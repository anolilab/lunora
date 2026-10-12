import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { TombstonePort } from "../src/tombstones";
import { tombstoneKeyOf } from "../src/tombstones";
import { memoryTombstones, SECRET, setup } from "./harness";

/** `null` leaves the secret out of the config, as an app that never set it would. */
const build = (tombstones: TombstonePort | null = null, tombstoneSecret: string | null = SECRET) =>
    setup({ rows: { tasks: 150 }, tombstones, tombstoneSecret });

describe("restore", () => {
    it("tombstones a subject once their erasure completes", async () => {
        const tombstones = memoryTombstones();
        const { privacy, runErasureWorkflow } = build(tombstones);
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(tombstones.stored.has(tombstoneKeyOf("u1", SECRET))).toBe(true);
    });

    it("erases again a subject restored from a backup taken before their erasure", async () => {
        const tombstones = memoryTombstones();
        const { operator, privacy, rows, runErasureWorkflow } = build(tombstones);
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);
        // The backup brings the rows back.
        rows.tasks = 150;

        await expect(operator.restore({ restoredSubjectIds: ["u1", "u2"] })).resolves.toStrictEqual(["u1"]);
        expect(rows.tasks).toBe(0);
    });

    it("rewrites the request rows a backup brought back to the tombstone key", async () => {
        const { operator, privacy, rows, runErasureWorkflow, store } = build(memoryTombstones());
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);
        // The backup holds the request as it was before the erasure, with the raw id.
        rows.tasks = 150;
        store.rows.set(opened.id, { ...store.rows.get(opened.id), subjectId: "u1" } as NonNullable<ReturnType<typeof store.rows.get>>);

        await operator.restore({ restoredSubjectIds: ["u1"] });

        expect(store.rows.get(opened.id)?.subjectId).toBe(tombstoneKeyOf("u1", SECRET));
    });

    it("refuses to restore without the tombstone secret", async () => {
        const { operator } = build(memoryTombstones(), null);

        await expect(operator.restore({ restoredSubjectIds: ["u1"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("fails an erasure before erasing anything when the tombstone secret is missing", async () => {
        const tombstones = memoryTombstones();
        const { privacy, rows, runErasureWorkflow, store } = build(tombstones, "");
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(rows.tasks).toBe(150);
        expect(tombstones.stored.size).toBe(0);
    });

    it("refuses the direct erasure entry without the tombstone secret", async () => {
        const { privacy, rows, store } = build(memoryTombstones(), null);
        const opened = await privacy.requestErasure();

        store.rows.set(opened.id, { ...store.rows.get(opened.id)!, status: "received" });

        await expect(privacy.runErasure(opened.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(rows.tasks).toBe(150);
    });

    it("replaces the raw subject id on every request of the subject with the tombstone key once the erasure completes", async () => {
        const tombstones = memoryTombstones();
        const { privacy, runErasureWorkflow, store } = build(tombstones);
        const exported = await privacy.requestExport();

        await privacy.runExport(exported.id);

        const erased = await privacy.requestErasure();

        await runErasureWorkflow(erased.id);

        const key = tombstoneKeyOf("u1", SECRET);

        expect(store.rows.get(erased.id)).toMatchObject({ status: "completed", subjectId: key });
        expect(store.rows.get(exported.id)?.subjectId).toBe(key);
        await expect(store.listForSubject("u1")).resolves.toStrictEqual([]);
        expect(tombstones.stored.has(key)).toBe(true);
    });

    it("keeps the raw subject id on a request whose erasure failed, so an operator can retry it", async () => {
        const failing: TombstonePort = {
            add: async () => {
                throw new Error("tombstone store unavailable");
            },
            keys: async () => new Set(),
        };
        const { privacy, runErasureWorkflow, store } = build(failing);
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.subjectId).toBe("u1");
    });

    it("leaves the erasure not completed when the tombstone write fails", async () => {
        const failing: TombstonePort = {
            add: async () => {
                throw new Error("tombstone store unavailable");
            },
            keys: async () => new Set(),
        };
        const { privacy, rows, runErasureWorkflow, store } = build(failing);
        const opened = await privacy.requestErasure();

        await runErasureWorkflow(opened.id);

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(store.events).not.toContain(`${opened.id}:completed`);
        // The tombstone goes first, so a store that cannot take it stops the erasure before any row goes.
        expect(rows.tasks).toBe(150);
    });

    it("refuses an erasure when the ports have no tombstone store, through either entry", async () => {
        const { privacy, rows, runErasureWorkflow, store } = setup({ erasure: { graceDays: 0 }, rows: { tasks: 150 }, tombstones: null });
        const direct = await privacy.requestErasure();

        await expect(privacy.runErasure(direct.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(store.rows.get(direct.id)?.status).toBe("received");

        await runErasureWorkflow(direct.id);

        expect(store.rows.get(direct.id)?.status).toBe("failed");
        expect(rows.tasks).toBe(150);
    });

    it("refuses to restore without a tombstone store", async () => {
        const { operator } = build();

        await expect(operator.restore({ restoredSubjectIds: ["u1"] })).rejects.toBeInstanceOf(LunoraError);
    });
});
