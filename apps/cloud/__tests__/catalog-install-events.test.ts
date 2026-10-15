import { describe, expect, it } from "vitest";

import { encodeInstallEvent, takeInstallEvents } from "../src/catalog/install-events";

const claimed = encodeInstallEvent({ event: "phase", phase: "claimed" });
const result = encodeInstallEvent({ deploymentId: "dep_1", event: "result", generated: [], kept: [], recorded: true });

describe("the install event parser", () => {
    it("reads the events of a whole chunk and holds nothing back", () => {
        expect(takeInstallEvents("", claimed + result)).toStrictEqual({
            events: [
                { event: "phase", phase: "claimed" },
                { deploymentId: "dep_1", event: "result", generated: [], kept: [], recorded: true },
            ],
            rest: "",
        });
    });

    it("holds a line a chunk ends in the middle of, and completes it from the next chunk", () => {
        const cut = Math.floor(claimed.length / 2);
        const first = takeInstallEvents("", claimed.slice(0, cut));

        expect(first).toStrictEqual({ events: [], rest: claimed.slice(0, cut) });

        const second = takeInstallEvents(first.rest, claimed.slice(cut));

        expect(second).toStrictEqual({ events: [{ event: "phase", phase: "claimed" }], rest: "" });
    });

    it("does not take a line the chunk split in two as an event, even when the first half is valid JSON", () => {
        const line = encodeInstallEvent({ event: "phase", phase: "live" });
        const beforeEnd = line.slice(0, -1);

        expect(takeInstallEvents("", beforeEnd)).toStrictEqual({ events: [], rest: beforeEnd });
    });

    it("skips blank lines", () => {
        expect(takeInstallEvents("", `\n${claimed}\n`).events).toStrictEqual([{ event: "phase", phase: "claimed" }]);
    });

    it("answers a line that is not JSON with an error event, so the form does not wait for an outcome that never comes", () => {
        expect(takeInstallEvents("", "not json\n").events).toStrictEqual([
            { error: "the install sent an event that could not be read", event: "error", status: 502 },
        ]);
    });
});
