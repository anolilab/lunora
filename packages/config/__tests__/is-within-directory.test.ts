import { describe, expect, it, vi } from "vitest";

import isWithinDirectory from "../src/is-within-directory";

// Run the helper against Windows path semantics on any host: the scan builds
// its paths with the host's `join`, so on Windows a `lunora\` file never
// started with the hard-coded `lunora/` prefix and every ctx read was dropped.
vi.mock(import("node:path"), async (importOriginal) => {
    const { win32 } = await importOriginal();

    return { ...win32, default: win32 };
});

describe(isWithinDirectory, () => {
    it("accepts a file under the directory with Windows separators", () => {
        expect.assertions(2);

        expect(isWithinDirectory(String.raw`C:\app\lunora\messages.ts`, String.raw`C:\app\lunora`)).toBe(true);
        expect(isWithinDirectory(String.raw`C:\app\lunora\nested\deep.tsx`, String.raw`C:\app\lunora`)).toBe(true);
    });

    it("rejects a sibling sharing the prefix, a parent, the directory itself and another drive", () => {
        expect.assertions(4);

        expect(isWithinDirectory(String.raw`C:\app\lunora-old\messages.ts`, String.raw`C:\app\lunora`)).toBe(false);
        expect(isWithinDirectory(String.raw`C:\app\src\index.ts`, String.raw`C:\app\lunora`)).toBe(false);
        expect(isWithinDirectory(String.raw`C:\app\lunora`, String.raw`C:\app\lunora`)).toBe(false);
        expect(isWithinDirectory(String.raw`D:\app\lunora\messages.ts`, String.raw`C:\app\lunora`)).toBe(false);
    });
});
