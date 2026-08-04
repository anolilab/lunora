import { describe, expect, it } from "vitest";

import { foldContainerInstances, parseContainerMessage } from "../../../src/features/containers/fold-container-instances";
import type { LogEntry } from "../../../src/lib/admin";

/** Build a `container:<name>` log entry the ShardDO emits for one lifecycle transition. */
const containerEntry = (name: string, message: string, timestamp: number, level: LogEntry["level"] = "info"): LogEntry => {
    return {
        functionPath: `container:${name}`,
        level,
        message,
        timestamp,
    };
};

describe("parseContainerMessage", () => {
    it("returns the bare event when there is no detail", () => {
        expect.assertions(1);

        expect(parseContainerMessage("start")).toStrictEqual({ event: "start" });
    });

    it("splits `<event>: <detail>` into the event token and trimmed detail", () => {
        expect.assertions(2);

        expect(parseContainerMessage("stop: hard timeout reached")).toStrictEqual({ detail: "hard timeout reached", event: "stop" });
        expect(parseContainerMessage("error: boom")).toStrictEqual({ detail: "boom", event: "error" });
    });

    it("treats an empty detail as absent", () => {
        expect.assertions(1);

        expect(parseContainerMessage("stop: ")).toStrictEqual({ event: "stop" });
    });
});

describe("foldContainerInstances", () => {
    it("maps each lifecycle transition to its current state", () => {
        expect.assertions(4);

        const rows = foldContainerInstances([
            containerEntry("a", "start", 10),
            containerEntry("b", "sleep", 20),
            containerEntry("c", "stop", 30),
            containerEntry("d", "error: boom", 40, "error"),
        ]);

        expect(rows.find((row) => row.name === "a")?.state).toBe("running");
        expect(rows.find((row) => row.name === "b")?.state).toBe("sleeping");
        expect(rows.find((row) => row.name === "c")?.state).toBe("stopped");
        expect(rows.find((row) => row.name === "d")?.state).toBe("error");
    });

    it("keeps only the most recent transition per container (instance up then down)", () => {
        expect.assertions(3);

        // Newest-first, as `getLogs` returns them: the stop (ts 200) wins over the start (ts 100).
        const rows = foldContainerInstances([containerEntry("transcoder", "stop: exited", 200), containerEntry("transcoder", "start", 100)]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe("stopped");
        expect(rows[0]?.detail).toBe("exited");
    });

    it("is order-independent — the greatest timestamp wins regardless of buffer order", () => {
        expect.assertions(1);

        const oldestLast = foldContainerInstances([containerEntry("x", "start", 100), containerEntry("x", "stop", 200)]);

        expect(oldestLast[0]?.state).toBe("stopped");
    });

    it("ignores non-container log entries", () => {
        expect.assertions(1);

        const rows = foldContainerInstances([
            { functionPath: "messages:list", level: "info", message: "ran", timestamp: 5 },
            { level: "error", message: "boom", timestamp: 6 },
            containerEntry("only", "start", 7),
        ]);

        expect(rows.map((row) => row.name)).toStrictEqual(["only"]);
    });

    it("carries the transition detail and severity, and sorts containers by name", () => {
        expect.assertions(3);

        const rows = foldContainerInstances([containerEntry("zeta", "start", 1), containerEntry("alpha", "error: crashed", 2, "error")]);

        expect(rows.map((row) => row.name)).toStrictEqual(["alpha", "zeta"]);
        expect(rows[0]?.detail).toBe("crashed");
        expect(rows[0]?.level).toBe("error");
    });

    it("falls back to `unknown` for an unmapped transition token", () => {
        expect.assertions(1);

        expect(foldContainerInstances([containerEntry("weird", "teleport", 1)])[0]?.state).toBe("unknown");
    });

    it("keeps concurrent instances of one container as distinct rows keyed per (name, instance)", () => {
        expect.assertions(4);

        const rows = foldContainerInstances([
            { exitCode: undefined, functionPath: "container:transcoder", instance: "do-a", level: "info", message: "start", timestamp: 10 },
            { exitCode: undefined, functionPath: "container:transcoder", instance: "do-b", level: "info", message: "start", timestamp: 11 },
        ]);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.instance)).toStrictEqual(["do-a", "do-b"]);
        expect(rows.every((row) => row.name === "transcoder")).toBe(true);
        expect(rows.every((row) => row.state === "running")).toBe(true);
    });

    it("folds transitions of the same instance and carries the parsed exit code", () => {
        expect.assertions(3);

        const rows = foldContainerInstances([
            { exitCode: 137, functionPath: "container:transcoder", instance: "do-a", level: "error", message: "stop: killed (exit 137)", timestamp: 200 },
            { exitCode: undefined, functionPath: "container:transcoder", instance: "do-a", level: "info", message: "start", timestamp: 100 },
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe("stopped");
        expect(rows[0]?.exitCode).toBe(137);
    });

    it("groups a container's instances together, ordered by instance id", () => {
        expect.assertions(1);

        const rows = foldContainerInstances([
            { functionPath: "container:zeta", instance: "do-2", level: "info", message: "start", timestamp: 1 },
            { functionPath: "container:alpha", instance: "do-9", level: "info", message: "start", timestamp: 2 },
            { functionPath: "container:alpha", instance: "do-1", level: "info", message: "start", timestamp: 3 },
        ]);

        expect(rows.map((row) => `${row.name}/${row.instance ?? ""}`)).toStrictEqual(["alpha/do-1", "alpha/do-9", "zeta/do-2"]);
    });
});
