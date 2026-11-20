import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { activeScope, resolveLocalWorkerEnv } from "../src/local-worker-env";

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

describe(resolveLocalWorkerEnv, () => {
    it("filters a .dev.vars key that is only an inherited name, such as constructor, under a secrets block", () => {
        expect.assertions(2);

        const directory = mkdtempSync(join(tmpdir(), "lunora-local-worker-env-"));

        try {
            writeFileSync(join(directory, ".dev.vars"), `${["constructor=leaked", "API_KEY=key"].join("\n")}\n`, "utf8");

            // Neither a var nor a required secret: the filter must drop it, not find it on Object.prototype.
            const { env } = resolveLocalWorkerEnv({ config: { secrets: { required: ["API_KEY"] } }, configPath: undefined, projectRoot: directory });

            expect(Object.hasOwn(env, "constructor")).toBe(false);
            expect(env["API_KEY"]).toBe("key");
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});
