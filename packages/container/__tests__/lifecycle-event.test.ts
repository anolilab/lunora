import { afterEach, describe, expect, it, vi } from "vitest";

import { emitContainerLifecycle } from "../src/lifecycle-event";

afterEach(() => {
    vi.restoreAllMocks();
});

describe(emitContainerLifecycle, () => {
    it("prints a lunora container event to console.log for non-error transitions", () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        emitContainerLifecycle("transcoder", "abc123", "start");

        expect(spy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({
            container: "transcoder",
            event: "start",
            instance: "abc123",
            level: "info",
            source: "lunora",
            type: "container",
        });
    });

    it("routes errors to console.error with the message and level", () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "error").mockImplementation(() => {});

        emitContainerLifecycle("transcoder", "abc123", "error", "boom");

        expect(spy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({ event: "error", level: "error", message: "boom" });
    });
});
