import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodegenProject, refreshCodegenProject, runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;
let lunoraDirectory: string;
let validatorsPath: string;

/**
 * `packages/vite/src/codegen-plugin.ts` reuses one ts-morph `Project` across
 * dev-loop codegen runs (`createCodegenProject` once, `refreshCodegenProject`
 * per save) to avoid a ~900ms full reparse on every keystroke. Before this
 * spec, `refreshCodegenProject` only resynced files INSIDE `lunoraDirectory`
 * — so a validator/type shared from outside it (a project's `src/`, pulled in
 * through the root tsconfig) stayed pinned at the version first parsed.
 * `resolveValidatorAlias` (parse-validator.ts) follows `getAliasedSymbol()`
 * across module boundaries, so that stale copy was genuinely read as the
 * current definition — `vite dev` and a fresh `lunora codegen` run would
 * silently emit different output from the same on-disk source.
 */
describe("reused Project — files outside lunora/", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-reuse-"));
        lunoraDirectory = join(workdir, "lunora");

        cpSync(join(fixtureRoot, "lunora"), lunoraDirectory, { recursive: true });

        // Every shipped template puts its tsconfig at the project root (see plan
        // 318 §1) — `findTsconfig` walks up from `lunoraDirectory` and finds this.
        writeFileSync(
            join(workdir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, target: "es2022" } }),
            "utf8",
        );

        mkdirSync(join(workdir, "src"), { recursive: true });
        validatorsPath = join(workdir, "src", "validators.ts");
        writeFileSync(validatorsPath, `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string() });\n`, "utf8");

        writeFileSync(
            join(lunoraDirectory, "listItems.ts"),
            `import { query } from "@lunora/server";

import { itemValidator } from "../src/validators";

export const listItems = query({
    args: { item: itemValidator },
    handler: async (_context, args) => {
        return args.item;
    },
});
`,
            "utf8",
        );
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reflects an edit to a shared validator outside lunoraDirectory after refreshing the shared Project", () => {
        expect.assertions(4);

        const project = createCodegenProject(lunoraDirectory);

        refreshCodegenProject(project, lunoraDirectory);

        const before = runCodegen({ lint: false, project, projectRoot: workdir });

        expect(before.generated.functions).toContain("title: string");
        expect(before.generated.functions).not.toContain("age: number");

        // Add a field to the validator on disk — NOT inside lunoraDirectory — then
        // refresh the SAME shared Project (what the plugin does on every save) and
        // re-run. Fails on pre-WS2 code: `age` never reaches the emitted output
        // because the reused Project never resyncs `src/validators.ts`.
        writeFileSync(
            validatorsPath,
            `import { v } from "@lunora/values";\n\nexport const itemValidator = v.object({ title: v.string(), age: v.number() });\n`,
            "utf8",
        );
        refreshCodegenProject(project, lunoraDirectory);

        const after = runCodegen({ lint: false, project, projectRoot: workdir });

        expect(after.generated.functions).toContain("age: number");

        // Control (plan §3.2): a freshly-constructed Project over the same
        // post-edit source must agree byte-for-byte with the refreshed, reused
        // one — `vite dev` and `lunora codegen` may never disagree.
        const fresh = runCodegen({ lint: false, projectRoot: workdir });

        expect(after.generated.functions).toBe(fresh.generated.functions);
    });
});
