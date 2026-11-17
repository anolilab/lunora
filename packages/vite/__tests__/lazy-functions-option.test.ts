import { describe, expect, it } from "vitest";

import { lunora } from "../src/index";

describe("lunora() lazyFunctions option", () => {
    // The option moved to `codegen.lazyFunctions` in lunora.config. A plugin still passing it would otherwise regenerate
    // the eager registry with no word, so the removed option is refused.
    it("refuses the removed lazyFunctions option instead of ignoring it", () => {
        expect.assertions(1);

        expect(() => lunora({ lazyFunctions: true } as unknown as Parameters<typeof lunora>[0])).toThrow(/lazyFunctions. option was removed/u);
    });
});
