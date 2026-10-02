/**
 * The `artifacts` fixture: an app whose actions read `ctx.artifacts`
 * (`@lunora/bindings/artifacts`, plan 460).
 *
 * The golden pins the three files the capability touches. The named assertions
 * pin the contract the plan states: the field rides ActionCtx only, at the type
 * AND the value level; a target that rates `artifacts` unsupported omits it with
 * a diagnostic; and a FedRAMP-pinned schema is refused, because Artifacts has no
 * FedRAMP namespace.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import assertArtifactsJurisdiction from "../src/assert-artifacts-jurisdiction";
import type { CodegenResult } from "../src/index";
import { runCodegen } from "../src/index";
import { makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "artifacts");
const expectedDirectory = join(fixtureRoot, "expected", "_generated");

/** The slice of a generated interface body between `export interface <name>` and its closing brace. */
const interfaceBody = (source: string, name: string): string => {
    const start = source.indexOf(`export interface ${name} `);

    return source.slice(start, source.indexOf("\n}\n", start));
};

describe("artifacts fixture", () => {
    let workdir: string;
    let generated: CodegenResult["generated"];

    // One codegen run for the golden assertions; `lint: false` matches `capture-expected.ts`.
    beforeAll(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
        generated = runCodegen({ lint: false, projectRoot: workdir }).generated;
    }, 300_000);

    afterAll(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("output matches the committed expected/ files (snapshot)", () => {
        expect.assertions(3);

        expect(generated.app).toBe(readFileSync(join(expectedDirectory, "app.ts"), "utf8"));
        expect(generated.server).toBe(readFileSync(join(expectedDirectory, "server.ts"), "utf8"));
        expect(generated.shard).toBe(readFileSync(join(expectedDirectory, "shard.ts"), "utf8"));
    });

    it("types ctx.artifacts on ActionCtx only", () => {
        expect.assertions(3);

        const field = 'readonly artifacts: import("@lunora/bindings/artifacts").ArtifactsClient;';

        expect(interfaceBody(generated.server, "ActionCtx")).toContain(field);
        expect(interfaceBody(generated.server, "QueryCtx")).not.toContain("artifacts");
        expect(interfaceBody(generated.server, "MutationCtx")).not.toContain("artifacts");
    });

    it("attaches the client only inside the action-only block, defaulting to env.ARTIFACTS", () => {
        expect.assertions(3);

        expect(generated.shard).toContain("const artifactsBinding = config.artifacts?.(env) ?? (env as Record<string, unknown>).ARTIFACTS;");
        expect(generated.shard).toContain("ctx.artifacts = artifacts;");
        // eslint-disable-next-line no-secrets/no-secrets -- asserting on a generated builder-method signature, not a credential
        expect(generated.app).toContain('public artifacts(factory: (env: Env) => ReturnType<NonNullable<ShardConfig["artifacts"]>>): this');
    });
});

describe("artifacts gating", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("omits ctx.artifacts on target node and reports platform_unsupported_feature", () => {
        expect.assertions(4);

        writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

        const result = runCodegen({ lint: false, projectRoot: workdir });
        const diagnostic = result.platformDiagnostics.find((entry) => entry.feature === "artifacts");

        expect(diagnostic?.name).toBe("platform_unsupported_feature");
        expect(diagnostic?.level).toBe("error");
        expect(result.generated.server).not.toContain("readonly artifacts:");
        expect(result.generated.shard).not.toContain("@lunora/bindings/artifacts");
    }, 300_000);

    it("refuses a fedramp-pinned schema that uses ctx.artifacts", () => {
        expect.assertions(1);

        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace("});\n", '}).jurisdiction("fedramp");\n'), "utf8");

        expect(() => runCodegen({ lint: false, projectRoot: workdir })).toThrow(/supports only the "eu" and "us" jurisdictions/);
    }, 300_000);

    it("ignores a type-only import: no ctx.artifacts and no fedramp refusal", () => {
        expect.assertions(2);

        // A queue consumer typing its messages with `ArtifactsEvent` never calls the binding.
        writeFileSync(
            join(workdir, "lunora", "repos.ts"),
            `import type { ArtifactsEvent } from "@lunora/bindings/artifacts";\n\nexport const isPush = (event: ArtifactsEvent): boolean => event.type === "cf.artifacts.repo.pushed";\n`,
            "utf8",
        );

        const schemaPath = join(workdir, "lunora", "schema.ts");

        writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace("});\n", '}).jurisdiction("fedramp");\n'), "utf8");

        const result = runCodegen({ lint: false, projectRoot: workdir });

        expect(result.generated.server).not.toContain("readonly artifacts:");
        expect(result.generated.shard).not.toContain("@lunora/bindings/artifacts");
    }, 300_000);
});

describe(assertArtifactsJurisdiction, () => {
    it("allows eu, us, unpinned, and fedramp without artifacts", () => {
        expect.assertions(4);

        expect(() => {
            assertArtifactsJurisdiction({ jurisdiction: "eu" }, true);
        }).not.toThrow();
        expect(() => {
            assertArtifactsJurisdiction({ jurisdiction: "us" }, true);
        }).not.toThrow();
        expect(() => {
            assertArtifactsJurisdiction({}, true);
        }).not.toThrow();
        expect(() => {
            assertArtifactsJurisdiction({ jurisdiction: "fedramp" }, false);
        }).not.toThrow();
    });

    it("throws a CODEGEN_DIAGNOSTIC for fedramp with artifacts", () => {
        expect.assertions(1);

        expect(() => {
            assertArtifactsJurisdiction({ jurisdiction: "fedramp" }, true);
        }).toThrow(expect.objectContaining({ code: "CODEGEN_DIAGNOSTIC" }));
    });
});
