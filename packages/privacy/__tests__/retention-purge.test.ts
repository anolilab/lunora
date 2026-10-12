import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { germany } from "../src/de";
import { ERASE_BATCH } from "../src/erasure";
import type { ArchivePort, DataPort } from "../src/ports";
import { retain } from "../src/rules";
import { codeOf, setup } from "./harness";

type Row = Readonly<Record<string, unknown>>;

interface ArchivedRow {
    readonly retainUntil: Date;
    readonly row: Row;
}

/** An archive in memory. `purgeBatch` deletes at most one batch of expired rows per call, as a real port would. */
const memoryArchive = (): ArchivePort & { calls: number; rows: ArchivedRow[] } => {
    const state = {
        calls: 0,
        purgeBatch: async (before: Date) => {
            state.calls += 1;

            const expired = state.rows.filter((entry) => entry.retainUntil.getTime() < before.getTime()).slice(0, ERASE_BATCH);

            state.rows = state.rows.filter((entry) => !expired.includes(entry));

            return { hasMore: expired.length === ERASE_BATCH, purged: expired.length };
        },
        rows: [] as ArchivedRow[],
    };

    return state;
};

const billing = defineDataset("billing", {
    legalBasis: "legal_obligation",
    origin: "provided",
    purpose: "Invoices the user was sent",
    tables: { invoices: { erase: retain("de.correspondence", { from: "issuedAt" }) } },
});

/** A data port that moves every `keep` row into the archive with the `until` its verdict carries. */
const archivingData = (archive: ReturnType<typeof memoryArchive>, invoices: Row[]): DataPort => {
    return {
        collect: async () => {
            return { invoices: [...invoices] };
        },
        eraseBatch: async (dataset, _subjectId, at, disposition) => {
            for (const row of invoices.splice(0)) {
                const verdict = disposition(dataset, "invoices", row, at);

                if (verdict.kind === "keep") {
                    archive.rows.push({ retainUntil: verdict.until, row });
                }
            }

            return { hasMore: false };
        },
        remaining: async () => {
            return { invoices: invoices.length };
        },
    };
};

describe("the retention archive purge", () => {
    it("purges an archived row once its retention period has ended, and not before", async () => {
        const archive = memoryArchive();
        const data = archivingData(archive, [{ id: "inv-1", issuedAt: new Date("2026-03-01T00:00:00.000Z") }]);
        const { operator, privacy, runErasureWorkflow, setClock, store } = setup({ archive, data, datasets: [billing], presets: [germany()] });
        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(archive.rows).toHaveLength(1);

        // Six years from the end of 2026: the row is kept to the end of 2032.
        setClock(new Date("2032-12-31T00:00:00.000Z"));

        await expect(operator.admin.sweep()).resolves.toStrictEqual({ expired: [], purged: 0 });
        expect(archive.rows).toHaveLength(1);

        setClock(new Date("2033-01-01T00:00:00.000Z"));

        await expect(operator.admin.sweep()).resolves.toStrictEqual({ expired: [], purged: 1 });
        expect(archive.rows).toStrictEqual([]);
    });

    it("drains more expired rows than one batch holds", async () => {
        const archive = memoryArchive();
        const past = new Date("2020-01-01T00:00:00.000Z");

        archive.rows = Array.from({ length: 2 * ERASE_BATCH + 5 }, (_, index) => {
            return { retainUntil: past, row: { id: index } };
        });

        const { operator } = setup({ archive, datasets: [billing], presets: [germany()] });

        await expect(operator.admin.sweep()).resolves.toMatchObject({ purged: 2 * ERASE_BATCH + 5 });
        expect(archive.rows).toStrictEqual([]);
        expect(archive.calls).toBe(3);
    });

    it("refuses to sweep without an archive port once a dataset retains rows", async () => {
        const { operator } = setup({ datasets: [billing], presets: [germany()] });

        await expect(codeOf(operator.admin.sweep())).resolves.toBe("BAD_REQUEST");
    });

    it("needs no archive port when no dataset retains rows", async () => {
        const { operator } = setup();

        await expect(operator.admin.sweep()).resolves.toStrictEqual({ expired: [], purged: 0 });
    });
});
