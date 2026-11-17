import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));

/** `@lunora/auth` is not a codegen dependency; the generated `SessionIdentity` import resolves to its real source. */
const SESSION_IDENTITY = join(here, "..", "..", "auth", "src", "session-identity.ts");

const ENTRY = `import { defineApp } from "lunorash";
export default defineApp().auth({
    d1: (env) => env.DB,
    options: { user: { additionalFields: { plan: { type: "string" }, seats: { type: "number", input: false } } } },
});
`;

/** Exact type equality: `any` and wider types do not pass. */
const EQUAL =
    "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;\nconst expectType = <T extends true>(): T => true as T;\n";

/** Run codegen over an app with the user columns above, then type-check `probe` against the generated `Identity`. */
const compileProbe = (identity: string | undefined, probe: string): string => {
    const workdir = mkdtempSync(join(here, "fixtures", ".workdir-"));
    const app = join(workdir, "lunora");

    try {
        mkdirSync(app);
        mkdirSync(join(workdir, "src", "server"), { recursive: true });
        writeFileSync(join(workdir, "src", "server", "index.ts"), ENTRY);
        writeFileSync(
            join(app, "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";\nexport default defineSchema({ notes: defineTable({ body: v.string() }) });\n`,
        );

        if (identity !== undefined) {
            writeFileSync(join(app, "identity.ts"), identity);
        }

        writeFileSync(join(app, "probe.ts"), `import type { Identity } from "./_generated/server.js";\n${EQUAL}${probe}`);
        runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

        const project = new Project({
            compilerOptions: {
                module: ModuleKind.ESNext,
                moduleResolution: ModuleResolutionKind.Bundler,
                noEmit: true,
                paths: { "@lunora/auth": [SESSION_IDENTITY] },
                skipLibCheck: true,
                strict: true,
                target: ScriptTarget.ES2022,
            },
        });

        project.addSourceFileAtPath(join(app, "probe.ts"));

        return project.formatDiagnosticsWithColorAndContext(project.getPreEmitDiagnostics());
    } finally {
        rmSync(workdir, { force: true, recursive: true });
    }
};

describe("generated ctx.auth identity types for user-column claims", () => {
    it("types the claims as optional on top of the session claims, and keeps other keys readable", () => {
        expect.assertions(1);

        const diagnostics = compileProbe(
            undefined,
            `expectType<Equal<Identity["plan"], string | undefined>>();
expectType<Equal<Identity["seats"], number | undefined>>();
expectType<Equal<Identity["userId"], string>>();
expectType<Equal<Identity["sub"], unknown>>();
const minimal: Identity = { userId: "u1" };
export { minimal };
`,
        );

        expect(diagnostics).toBe("");
    });

    it("lets a declared contract's key win over a claim of the same name", () => {
        expect.assertions(1);

        const diagnostics = compileProbe(
            `import { defineIdentity, v } from "@lunora/server";\nexport const identity = defineIdentity({ userId: v.string(), plan: v.number() });\n`,
            `expectType<Equal<Identity["plan"], number>>();
expectType<Equal<Identity["seats"], number | undefined>>();
`,
        );

        expect(diagnostics).toBe("");
    });

    it("reports a wrong expectation, so a passing probe means the types matched", () => {
        expect.assertions(1);

        expect(compileProbe(undefined, `expectType<Equal<Identity["plan"], string>>();\n`)).toContain("TS2344");
    });
});
