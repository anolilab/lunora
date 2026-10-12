import { describe, expect, it } from "vitest";

import type { PrivacyConfig } from "../src/define";
import { definePrivacy } from "../src/define";
import { eu } from "../src/eu";
import { tombstoneKeyOf } from "../src/tombstones";
import { decodeWire, dispatchPort, encodeWire, PORT_METHODS, portMethods, remotePorts } from "../src/workflow";
import { codeOf, memoryData, memoryFiles, memoryRequests, memoryTombstones, NOW, SECRET, SUBJECT, tasksDataset } from "./harness";

describe("the wire codec", () => {
    it("round-trips a Date, a Set, a byte array and undefined, nested anywhere", () => {
        const value = {
            at: new Date("2026-10-11T10:00:00.000Z"),
            bytes: new Uint8Array([0, 1, 254, 255]),
            list: [undefined, new Set(["a", "b"]), { nested: new Date(0) }],
            missing: undefined,
            plain: { count: 3, name: "x" },
        };

        expect(decodeWire(encodeWire(value))).toStrictEqual(value);
    });

    it("keeps a plain object that happens to look like a tag", () => {
        const value = [{ $date: "not a date" }, { $undefined: true }, { $object: 1 }];

        expect(decodeWire(encodeWire(value))).toStrictEqual(value);
    });

    it("carries undefined as a value, not as null", () => {
        expect(decodeWire(encodeWire([undefined]))).toStrictEqual([undefined]);
        expect(decodeWire(encodeWire(undefined))).toBeUndefined();
    });
});

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

describe("the port method table", () => {
    it("lists exactly the methods of every remote port", () => {
        const ports = allPorts();

        for (const [port, methods] of Object.entries(PORT_METHODS)) {
            const bound = Object.entries(ports[port as keyof typeof PORT_METHODS])
                .filter(([, member]) => typeof member === "function")
                .map(([name]) => name)
                .toSorted((a, b) => a.localeCompare(b));

            expect(Object.keys(methods).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(bound);
        }
    });

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
        expect([...new Set(reached)].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([...portMethods()].toSorted((a, b) => a.localeCompare(b)));
    });

    it("refuses a method the table does not list, and a port the call did not bind", async () => {
        const { data, files, newId, now, store, tombstones } = allPorts();
        const withoutArchive = { data, files, newId, now, store, tombstones };
        const config = { datasets: [tasksDataset] };

        await expect(codeOf(dispatchPort(config, withoutArchive, "store.drop", "[]"))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "constructor.name", "[]"))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "archive.purgeBatch", encodeWire([NOW])))).resolves.toBe("BAD_REQUEST");
        await expect(codeOf(dispatchPort(config, withoutArchive, "data.collect", encodeWire(["unknown", "u1"])))).resolves.toBe("BAD_REQUEST");
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
