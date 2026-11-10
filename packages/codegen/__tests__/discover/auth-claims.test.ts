import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAuthClaims from "../../src/discover/auth-claims";

let workdir: string;
let project: Project;

const write = (relative: string, source: string): void => {
    const path = join(workdir, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
};

/** A worker entry that declares `.auth()` with the given options expression, plus the options file. */
const entry = (options: string): string => `import { defineApp } from "lunorash";
import { authOptions } from "../../lunora/auth";
export default defineApp().auth({ d1: (env) => env.DB, options: ${options} });
`;

const AUTH_WITH = (userBody: string): string => `export const authOptions = (env: { SECRET: string }) => {
    return {
        secret: env.SECRET,
        user: { ${userBody} },
    };
};
`;

const run = () => discoverAuthClaims(project, join(workdir, "lunora"));

describe("discoverAuthClaims", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-auth-claims-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads a scalar user column from an options object imported from lunora/auth", () => {
        expect.assertions(1);

        write("lunora/auth.ts", AUTH_WITH(`additionalFields: { plan: { type: "string" }, seats: { type: "number", input: false } }`));
        write("src/server/index.ts", entry("authOptions"));

        expect(run()).toStrictEqual({
            claims: [
                { name: "plan", type: "string", writable: true },
                { name: "seats", type: "number", writable: false },
            ],
            diagnostics: [],
        });
    });

    it("reads an inline arrow options function", () => {
        expect.assertions(1);

        write("src/server/index.ts", entry(`(env) => ({ secret: env.SECRET, user: { additionalFields: { tier: { type: "boolean" } } } })`));

        expect(run().claims).toStrictEqual([{ name: "tier", type: "boolean", writable: true }]);
    });

    it("reads a block-bodied function with one return", () => {
        expect.assertions(1);

        write("src/server/index.ts", entry(`(env) => { return { user: { additionalFields: { region: { type: "string" } } } }; }`));

        expect(run().claims).toStrictEqual([{ name: "region", type: "string", writable: true }]);
    });

    it("maps a date column to a string claim (its ISO form)", () => {
        expect.assertions(1);

        write("src/server/index.ts", entry(`{ user: { additionalFields: { joinedAt: { type: "date" } } } }`));

        expect(run().claims).toStrictEqual([{ name: "joinedAt", type: "string", writable: true }]);
    });

    it("leaves out a column the session does not return", () => {
        expect.assertions(1);

        write("src/server/index.ts", entry(`{ user: { additionalFields: { internal: { type: "string", returned: false }, plan: { type: "string" } } } }`));

        expect(run().claims.map((claim) => claim.name)).toStrictEqual(["plan"]);
    });

    it("excludes reserved and secret-bearing names with a diagnostic", () => {
        expect.assertions(2);

        write(
            "src/server/index.ts",
            entry(`{ user: { additionalFields: { roles: { type: "string" }, token: { type: "string" }, plan: { type: "string" } } } }`),
        );

        const result = run();

        expect(result.claims.map((claim) => claim.name)).toStrictEqual(["plan"]);
        expect(result.diagnostics).toHaveLength(2);
    });

    it("excludes json, array and unknown types with a diagnostic", () => {
        expect.assertions(2);

        write(
            "src/server/index.ts",
            entry(`{ user: { additionalFields: { prefs: { type: "json" }, scores: { type: "number[]" }, plan: { type: "string" } } } }`),
        );

        const result = run();

        expect(result.claims.map((claim) => claim.name)).toStrictEqual(["plan"]);
        expect(result.diagnostics).toHaveLength(2);
    });

    it("refuses a name the claim list cannot carry, with a diagnostic", () => {
        expect.assertions(2);

        write("src/server/index.ts", entry(`{ user: { additionalFields: { "my-field": { type: "string" }, ok: { type: "string" } } } }`));

        const result = run();

        expect(result.claims.map((claim) => claim.name)).toStrictEqual(["ok"]);
        expect(result.diagnostics).toStrictEqual(["`my-field` is not an identifier of at most 64 characters; it is not added to ctx.auth"]);
    });

    it("caps the claims at 32 and says so", () => {
        expect.assertions(2);

        const fields = Array.from({ length: 33 }, (_, index) => `c${String(index)}: { type: "string" }`).join(", ");

        write("src/server/index.ts", entry(`{ user: { additionalFields: { ${fields} } } }`));

        const result = run();

        expect(result.claims).toHaveLength(32);
        expect(result.diagnostics).toHaveLength(1);
    });

    it("yields no claims, with a diagnostic, when the options are opaque", () => {
        expect.assertions(2);

        write(
            "lunora/auth.ts",
            `export const authOptions = (env: { SECRET: string }) => ({ ...base(env), user: { additionalFields: { plan: { type: "string" } } } });\n`,
        );
        write("src/server/index.ts", entry("authOptions"));

        const result = run();

        expect(result.claims).toStrictEqual([]);
        expect(result.diagnostics).toHaveLength(1);
    });

    it("yields no claims when the config declares no additionalFields", () => {
        expect.assertions(1);

        write("lunora/auth.ts", AUTH_WITH(`emailAndPassword: { enabled: true }`));
        write("src/server/index.ts", entry("authOptions"));

        expect(run()).toStrictEqual({ claims: [], diagnostics: [] });
    });
});
