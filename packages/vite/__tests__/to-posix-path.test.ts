import { describe, expect, it } from "vitest";

import toPosixPath from "../src/to-posix-path";

describe("toPosixPath", () => {
    it("turns a win32 relative path into the forward-slash key the metafile uses", () => {
        expect.assertions(1);

        expect(toPosixPath(String.raw`src\worker\index.ts`, "\\")).toBe("src/worker/index.ts");
    });

    it("leaves a POSIX path as it is", () => {
        expect.assertions(1);

        expect(toPosixPath("src/worker/index.ts", "/")).toBe("src/worker/index.ts");
    });
});
