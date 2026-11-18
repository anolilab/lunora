import { describe, expect, it } from "vitest";

import { activeScope } from "../src/local-worker-env";

describe(activeScope, () => {
    it("falls back to the top level for a name that is only an inherited Object property", () => {
        expect.assertions(1);

        // `constructor` resolves through the prototype of `env`; it names no environment, so wrangler's fallback applies.
        expect(activeScope({ env: {}, vars: { STAGE: "top" } }, "constructor")).toStrictEqual({ env: {}, vars: { STAGE: "top" } });
    });

    it("picks a declared environment's own block", () => {
        expect.assertions(1);

        expect(activeScope({ env: { staging: { vars: { STAGE: "staging" } } }, vars: { STAGE: "top" } }, "staging")).toStrictEqual({
            vars: { STAGE: "staging" },
        });
    });
});
