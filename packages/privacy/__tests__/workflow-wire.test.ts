import { decodeWire, encodeWire } from "@lunora/wire";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { PrivacyConfig } from "../src/define";
import { definePrivacy } from "../src/define";
import { eu } from "../src/eu";
import { tombstoneKeyOf } from "../src/tombstones";
import { dispatchPort, remotePorts } from "../src/workflow";
import { codeOf, durableStep, exportFileOf, memoryData, memoryFiles, memoryRequests, memoryTombstones, NOW, SECRET, SUBJECT, tasksDataset } from "./harness";

/** A port call's payload as `remotePorts` writes it. */
const payloadOf = (args: ReadonlyArray<unknown>): string => JSON.stringify(encodeWire(args));

/** Ports with every optional port bound, so the table can be checked against each one. */
const allPorts = () => {
    return {
        archive: {
            purgeBatch: async () => {
                return { hasMore: false, purged: 0 };
            },
        },
        data: memoryData({ goals: 150, tasks: 40 }),
        files: memoryFiles(),
        newId: () => "r1",
        now: () => NOW,
        store: memoryRequests(),
        tombstones: memoryTombstones(),
    };
};

describe("the port wire", () => {
    it("returns a bigint, an ArrayBuffer and a Date column from a data call as they were", async () => {
        const rows = { goals: [], tasks: [{ at: new Date(0), blob: new Uint8Array([0, 1, 254, 255]).buffer, id: 12_345_678_901_234_567_890n }] };
        const remote = remotePorts(async ({ method, payload }) =>
            dispatchPort({ datasets: [tasksDataset] }, { ...allPorts(), data: { ...memoryData(), collect: async () => rows } }, method, payload),
        );

        await expect(remote.data.collect(tasksDataset, "u1")).resolves.toStrictEqual(rows);
    });

    it("passes an undefined argument as undefined, a Date as a Date and bytes as bytes", async () => {
        const local = allPorts();
        const seen: unknown[][] = [];
        const remote = remotePorts(async ({ method, payload }) =>
            dispatchPort(
                { datasets: [tasksDataset] },
                {
                    ...local,
                    store: {
                        ...local.store,
                        addEvent: async (...args) => {
                            seen.push(args);
                        },
                    },
                },
                method,
                payload,
            ),
        );

        await remote.store.addEvent("r1", NOW, "kind", undefined);
        await remote.files.put("r1", { data: new Uint8Array([1, 2]), name: "a.bin" });

        expect(seen).toStrictEqual([["r1", NOW, "kind", undefined]]);
        expect(local.files.files.get("r1/a.bin")).toStrictEqual(new Uint8Array([1, 2]));
    });
});

describe("the port codec table", () => {
    it("reaches every listed method through remotePorts and dispatchPort", async () => {
        const local = allPorts();
        const config = { datasets: [tasksDataset], presets: [eu()] };
        const reached: string[] = [];
        const remote = remotePorts(async ({ method, payload }) => {
            reached.push(method);

            return dispatchPort(config, local, method, payload);
        });

        await remote.store.insert({ dueAt: NOW, id: "r1", receivedAt: NOW, status: "received", subjectId: "u1", type: "export" });
        await remote.store.addEvent("r1", NOW, "received", undefined);

        await expect(remote.store.get("r1")).resolves.toMatchObject({ dueAt: NOW, id: "r1" });
        await expect(remote.store.get("missing")).resolves.toBeUndefined();
        await expect(remote.store.findOpen("u1", "export")).resolves.toMatchObject({ id: "r1" });
        await expect(remote.store.listForSubject("u1")).resolves.toHaveLength(1);
        await expect(remote.store.listOpen()).resolves.toHaveLength(1);

        await remote.store.update("r1", { status: "processing" });

        await expect(remote.data.collect(tasksDataset, "u1")).resolves.toHaveProperty("tasks");
        await expect(
            remote.data.eraseBatch(tasksDataset, "u1", NOW, () => {
                return { kind: "delete" };
            }),
        ).resolves.toStrictEqual({ hasMore: true });
        await expect(remote.data.remaining(tasksDataset, "u1")).resolves.toStrictEqual({ goals: 50, tasks: 0 });
        await expect(remote.files.put("r1", { data: new Uint8Array([1, 2]), name: "a.bin" })).resolves.toBe("r1/a.bin");
        expect(local.files.files.get("r1/a.bin")).toStrictEqual(new Uint8Array([1, 2]));
        await expect(remote.files.read("r1", "a.bin")).resolves.toBeUndefined();
        await expect(remote.files.list("r1/")).resolves.toStrictEqual(["r1/a.bin"]);
        await expect(remote.files.signedUrl("r1/a.bin", 60)).resolves.toContain("r1/a.bin");

        await remote.files.delete("r1/a.bin");
        await remote.tombstones.add("k", NOW);

        await expect(remote.tombstones.keys()).resolves.toStrictEqual(new Set(["k"]));
        await expect(remote.archive.purgeBatch(NOW)).resolves.toStrictEqual({ hasMore: false, purged: 0 });

        expect(local.store.rows.get("r1")?.status).toBe("processing");
        expect([...new Set(reached)].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "archive.purgeBatch",
            "data.collect",
            "data.eraseBatch",
            "data.remaining",
            "files.delete",
            "files.list",
            "files.put",
            "files.read",
            "files.signedUrl",
            "store.addEvent",
            "store.findOpen",
            "store.get",
            "store.insert",
            "store.listForSubject",
            "store.listOpen",
            "store.update",
            "tombstones.add",
            "tombstones.keys",
        ]);
    });

    it("refuses a method the table does not list, and a port the call did not bind", async () => {
        const { data, files, newId, now, store, tombstones } = allPorts();
        const withoutArchive = { data, files, newId, now, store, tombstones };
        const config = { datasets: [tasksDataset] };

        await expect(codeOf(dispatchPort(config, withoutArchive, "store.drop", "[]"))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "constructor.name", "[]"))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "archive.purgeBatch", payloadOf([NOW])))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "data.collect", payloadOf(["unknown", "u1"])))).resolves.toBe("BAD_REQUEST");
    });
});

describe("a workflow over the wire", () => {
    it("runs an erasure end to end with the disposition rebuilt on the dispatcher side", async () => {
        const local = allPorts();
        const config: PrivacyConfig<"local" | "remote"> = {
            datasets: [tasksDataset],
            ports: (side) => (side === "local" ? local : remotePorts(async ({ method, payload }) => dispatchPort(config, local, method, payload))),
            presets: [eu()],
            tombstoneSecret: SECRET,
        };
        const privacyFor = definePrivacy(config);
        const opened = await privacyFor("local", SUBJECT).requestErasure();

        await privacyFor("remote").workflows.erasureHandler({
            params: { requestId: opened.id },
            step: { do: async (_name, run) => run(), sleepUntil: async () => undefined },
        });

        expect(local.store.rows.get(opened.id)).toMatchObject({ status: "completed", subjectId: tombstoneKeyOf("u1", SECRET) });
        expect(local.data.rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(local.tombstones.stored.size).toBe(1);
    });

    it("gives every port call its own dedup id, and a retried step runs its erase again", async () => {
        const local = allPorts();
        const dedupIds: string[] = [];
        const config: PrivacyConfig<"local" | "remote"> = {
            datasets: [tasksDataset],
            ports: (side) => {
                if (side === "local") {
                    return local;
                }

                return remotePorts(async ({ method, payload }, { dedupId }) => {
                    dedupIds.push(dedupId);

                    return dispatchPort(config, local, method, payload);
                });
            },
            presets: [eu()],
            tombstoneSecret: SECRET,
        };
        const privacyFor = definePrivacy(config);
        const opened = await privacyFor("local", SUBJECT).requestErasure();
        const { step } = durableStep({ failOnce: "erase:tasks" });

        await privacyFor("remote").workflows.erasureHandler({ params: { requestId: opened.id }, step });

        expect(local.store.rows.get(opened.id)?.status).toBe("completed");
        expect(local.data.rows).toStrictEqual({ goals: 0, tasks: 0 });
        expect(dedupIds.length).toBeGreaterThan(0);
        expect(new Set(dedupIds).size).toBe(dedupIds.length);
    });

    it("erases nothing when the dispatcher side has no tombstone store bound", async () => {
        const { data, files, newId, now, store } = allPorts();
        const local = { data, files, newId, now, store };
        const config: PrivacyConfig<"local" | "remote"> = {
            datasets: [tasksDataset],
            ports: (side) => (side === "local" ? local : remotePorts(async ({ method, payload }) => dispatchPort(config, local, method, payload))),
            presets: [eu()],
            tombstoneSecret: SECRET,
        };
        const privacyFor = definePrivacy(config);
        const opened = await privacyFor("local", SUBJECT).requestErasure();

        await privacyFor("remote").workflows.erasureHandler({
            params: { requestId: opened.id },
            step: { do: async (_name, run) => run(), sleepUntil: async () => undefined },
        });

        expect(store.rows.get(opened.id)?.status).toBe("failed");
        expect(data.rows).toStrictEqual({ goals: 150, tasks: 40 });
    });
});

describe("an export over the wire", () => {
    it("archives a bigint and a bytes column a remote collect returned, losing neither", async () => {
        const row = { blob: new Uint8Array([0, 1, 254, 255]).buffer, id: 12_345_678_901_234_567_890n };
        const base = allPorts();
        const local = {
            ...base,
            data: {
                ...base.data,
                collect: async () => {
                    return { goals: [], tasks: [row] };
                },
            },
        };
        const config: PrivacyConfig<"local" | "remote"> = {
            datasets: [tasksDataset],
            ports: (side) => (side === "local" ? local : remotePorts(async ({ method, payload }) => dispatchPort(config, local, method, payload))),
            presets: [eu()],
            tombstoneSecret: SECRET,
        };
        const privacyFor = definePrivacy(config);
        const opened = await privacyFor("local", SUBJECT).requestExport();

        await privacyFor("remote").workflows.exportHandler({ params: { requestId: opened.id }, step: durableStep().step });

        expect(local.store.rows.get(opened.id)?.status).toBe("ready");

        const text = new TextDecoder().decode(
            unzipSync(local.files.files.get(exportFileOf(local.files, opened.id, "export.zip")) as Uint8Array)["data/tasks/tasks.json"],
        );

        expect(decodeWire(JSON.parse(text))).toStrictEqual([row]);
    });
});
