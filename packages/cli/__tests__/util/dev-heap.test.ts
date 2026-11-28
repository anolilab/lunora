import { describe, expect, it } from "vitest";

import { DEV_HEAP_TARGET_MB, devHeapNodeOptions } from "../../src/util/dev-heap";

const GIB = 1024 * 1024 * 1024;
const memory = (availableGiB: number, currentLimitGiB = 4): { availableBytes: number; currentLimitBytes: number } => {
    return { availableBytes: availableGiB * GIB, currentLimitBytes: currentLimitGiB * GIB };
};

describe(devHeapNodeOptions, () => {
    it("raises the heap to the target on a machine with room for it", () => {
        expect.assertions(1);

        expect(devHeapNodeOptions(undefined, memory(62), [])).toBe(`--max-old-space-size=${String(DEV_HEAP_TARGET_MB)}`);
    });

    it("keeps the options already set and appends the flag", () => {
        expect.assertions(1);

        expect(devHeapNodeOptions("--enable-source-maps", memory(62), [])).toBe(`--enable-source-maps --max-old-space-size=${String(DEV_HEAP_TARGET_MB)}`);
    });

    it.each(["--max-old-space-size=2048", "--max_old_space_size=2048"])("never overrides a heap size the user chose (%s)", (existing) => {
        expect.assertions(1);

        expect(devHeapNodeOptions(existing, memory(62), [])).toBeUndefined();
    });

    it("carries a heap size from the launcher's own command line, which the child does not inherit", () => {
        expect.assertions(1);

        expect(devHeapNodeOptions("--enable-source-maps", memory(62, 16), ["--max-old-space-size=16384"])).toBe(
            "--enable-source-maps --max-old-space-size=16384",
        );
    });

    it("caps the heap at three quarters of the available memory", () => {
        expect.assertions(1);

        expect(devHeapNodeOptions(undefined, memory(8, 2), [])).toBe("--max-old-space-size=6144");
    });

    it("leaves the limit alone when memory would not allow more than V8 already has", () => {
        expect.assertions(1);

        expect(devHeapNodeOptions(undefined, memory(4), [])).toBeUndefined();
    });
});
