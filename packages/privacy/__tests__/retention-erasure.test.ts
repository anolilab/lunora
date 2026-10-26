import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defineDataset } from "../src/dataset";
import { germany } from "../src/de";
import type { DataPort } from "../src/ports";
import { retain } from "../src/rules";
import { exportFileOf, memoryFiles, memoryRequests, NOW, setup } from "./harness";

type Row = Readonly<Record<string, unknown>>;

const billing = defineDataset("billing", {
    legalBasis: "legal_obligation",
    origin: "provided",
    purpose: "Invoices the user was sent",
    tables: { invoices: { erase: retain("de.books", { from: "issuedAt" }) }, notes: {} },
});

const tasks = defineDataset("tasks", {
    legalBasis: "contract",
    origin: "provided",
    purpose: "Tasks the user schedules",
    tables: { tasks: {} },
});

/** An invoice still inside the ten-year period, and one whose period ended long ago. */
const RECENT = { id: "inv-recent", issuedAt: new Date("2026-03-01T00:00:00.000Z") };
const OLD = { id: "inv-old", issuedAt: new Date("2010-03-01T00:00:00.000Z") };

/**
 * A data port over real rows. It applies the package's disposition the way an app would:
 * `keep` rows move to the archive (or, with `archive: false`, stay in place and are not
 * selected again). With `ignoreDelete`, a row marked for deletion is left behind.
 */
const rowData = (options: { archive?: boolean; ignoreDelete?: boolean } = {}) => {
    const tables: Record<string, Row[]> = { invoices: [RECENT, OLD], notes: [{ id: "n1" }], tasks: [{ id: "t1" }] };
    const archive: Row[] = [];
    const judged = new Set<Row>();

    const port: DataPort = {
        collect: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, [...(tables[table] ?? [])]])),
        eraseBatch: async (dataset, _subjectId, at, disposition) => {
            for (const table of dataset.tableNames) {
                const live = tables[table] ?? [];

                for (const row of live.filter((candidate) => !judged.has(candidate))) {
                    const verdict = disposition(dataset, table, row, at);

                    if (verdict.kind === "keep") {
                        if (options.archive === false) {
                            judged.add(row);
                        } else {
                            archive.push(row);
                            tables[table] = (tables[table] ?? []).filter((candidate) => candidate !== row);
                        }
                    } else if (options.ignoreDelete === true) {
                        judged.add(row);
                    } else {
                        tables[table] = (tables[table] ?? []).filter((candidate) => candidate !== row);
                    }
                }
            }

            return { hasMore: false };
        },
        remaining: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, (tables[table] ?? []).length])),
    };

    return { archive, port, tables };
};

const build = (data: DataPort, datasets = [billing]) => setup({ data, datasets, presets: [germany()] });

describe("retention during erasure", () => {
    it("deletes a row whose period has ended and archives one whose period is running", async () => {
        const { archive, port, tables } = rowData();
        const { privacy, runErasureWorkflow, store } = build(port);
        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(tables).toStrictEqual({ invoices: [], notes: [], tasks: [{ id: "t1" }] });
        expect(archive).toStrictEqual([RECENT]);
    });

    it("completes when a kept row is still counted in its table", async () => {
        const { port, tables } = rowData({ archive: false });
        const { privacy, runErasureWorkflow, store } = build(port);
        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(tables.invoices).toStrictEqual([RECENT]);
    });

    it("fails when a retained table still holds a row the rule no longer keeps", async () => {
        const { port } = rowData({ archive: false, ignoreDelete: true });
        const { privacy, store } = build(port);
        const erasure = await privacy.requestErasure();

        store.rows.set(erasure.id, { ...store.rows.get(erasure.id)!, status: "received" });

        await expect(privacy.runErasure(erasure.id)).resolves.toStrictEqual({ leftover: ["invoices", "notes"], status: "failed" });
    });

    it("expires an export that turned ready after the erasure removed its files, when the erasure then fails", async () => {
        const { port } = rowData({ archive: false, ignoreDelete: true });
        const store = memoryRequests();
        let claiming: string | undefined;
        // The first verify read happens after the erasure's files step, so an export that claims ready there is ready after its
        // files were removed. The erasure then fails at verify, and only that failure can expire the export.
        const racing = {
            ...port,
            remaining: async (...args: Parameters<DataPort["remaining"]>) => {
                if (claiming !== undefined) {
                    store.rows.set(claiming, {
                        ...store.rows.get(claiming)!,
                        expiresAt: new Date(NOW.getTime() + 60_000),
                        status: "ready",
                        storageKey: `${claiming}/run/export.zip`,
                    });
                    claiming = undefined;
                }

                return port.remaining(...args);
            },
        };
        const { privacy } = setup({ data: racing, datasets: [billing], presets: [germany()], store });
        const exported = await privacy.requestExport();

        claiming = exported.id;

        const erasure = await privacy.requestErasure();

        store.rows.set(erasure.id, { ...store.rows.get(erasure.id)!, status: "received" });

        await expect(privacy.runErasure(erasure.id)).resolves.toStrictEqual({ leftover: ["invoices", "notes"], status: "failed" });
        expect(store.rows.get(exported.id)?.status).toBe("expired");
    });

    it("expires a ready export when an erasure crashes after writing its tombstone", async () => {
        const { port } = rowData({ archive: false });
        let crashing = false;
        // The tombstone is the first step, so the erasure has written it when its first drain throws. Rows may already be gone.
        const failing = {
            ...port,
            eraseBatch: async (...args: Parameters<DataPort["eraseBatch"]>) => {
                if (crashing) {
                    throw new Error("storage unavailable");
                }

                return port.eraseBatch(...args);
            },
        };
        const { privacy, store } = build(failing);
        const exported = await privacy.requestExport();

        await expect(privacy.runExport(exported.id)).resolves.toMatchObject({ status: "ready" });

        const erasure = await privacy.requestErasure();

        store.rows.set(erasure.id, { ...store.rows.get(erasure.id)!, status: "received" });
        crashing = true;

        await expect(privacy.runErasure(erasure.id)).resolves.toMatchObject({ status: "failed" });
        expect(store.rows.get(exported.id)?.status).toBe("expired");
    });

    it("fails an erasure whose crash leaves an export's archive that cannot be deleted", async () => {
        const { port } = rowData({ archive: false });
        const files = memoryFiles();
        let crashing = false;
        const failing = {
            ...port,
            eraseBatch: async (...args: Parameters<DataPort["eraseBatch"]>) => {
                if (crashing) {
                    throw new Error("storage unavailable");
                }

                return port.eraseBatch(...args);
            },
        };
        const flaky = {
            ...files,
            delete: async (key: string) => {
                if (crashing && key.endsWith("/export.zip")) {
                    throw new Error("archive delete unavailable");
                }

                await files.delete(key);
            },
        };
        const { privacy, store } = setup({ data: failing, datasets: [billing], presets: [germany()], files: flaky });
        const exported = await privacy.requestExport();

        await expect(privacy.runExport(exported.id)).resolves.toMatchObject({ status: "ready" });

        const erasure = await privacy.requestErasure();

        store.rows.set(erasure.id, { ...store.rows.get(erasure.id)!, status: "received" });
        crashing = true;

        await expect(privacy.runErasure(erasure.id)).rejects.toThrow("archive delete unavailable");
        expect(store.rows.get(erasure.id)?.status).toBe("failed");
    });

    it("marks a dataset with a retained table as restricted in the manifest", async () => {
        const { port } = rowData();
        const { files, privacy } = build(port, [billing, tasks]);
        const opened = await privacy.requestExport();

        await privacy.runExport(opened.id);

        const archive = unzipSync(files.files.get(exportFileOf(files, opened.id, "export.zip")) as Uint8Array);
        const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"])) as { datasets: { id: string; restricted: boolean }[] };

        expect(manifest.datasets.map(({ id, restricted }) => [id, restricted])).toStrictEqual([
            ["billing", true],
            ["tasks", false],
        ]);
    });

    it("completes a full erasure that anonymises a table, though the anonymised rows are still counted", async () => {
        const comments = defineDataset("comments", {
            legalBasis: "legitimate_interest",
            origin: "provided",
            purpose: "Comments the user wrote on shared tasks",
            tables: { comments: { erase: "anonymise" }, reactions: {} },
        });
        const rows: Record<string, Row[]> = {
            comments: [
                { author: "Ada", body: "looks good", id: "c1" },
                { author: "Ada", body: "done", id: "c2" },
            ],
            reactions: [{ id: "x1" }],
        };
        const data: DataPort = {
            collect: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, [...(rows[table] ?? [])]])),
            eraseBatch: async (dataset, _subjectId, at, disposition) => {
                for (const table of dataset.tableNames) {
                    rows[table] = (rows[table] ?? []).flatMap((row) => {
                        const verdict = disposition(dataset, table, row, at);

                        // An anonymised row stays, without the fields that identify the subject.
                        return verdict.kind === "anonymise" ? [{ ...row, author: undefined, anonymised: true }] : [];
                    });
                }

                return { hasMore: false };
            },
            // This port still counts the anonymised rows under the subject, as a port that keeps the owner column would.
            remaining: async (dataset) => Object.fromEntries(dataset.tableNames.map((table) => [table, (rows[table] ?? []).length])),
        };
        const { privacy, runErasureWorkflow, store } = setup({ data, datasets: [comments] });
        const erasure = await privacy.requestErasure();

        await runErasureWorkflow(erasure.id);

        expect(store.rows.get(erasure.id)?.status).toBe("completed");
        expect(rows.comments).toHaveLength(2);
        expect(rows.comments?.every((row) => row.author === undefined)).toBe(true);
        expect(rows.reactions).toStrictEqual([]);
    });
});
