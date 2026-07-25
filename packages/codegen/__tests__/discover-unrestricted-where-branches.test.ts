import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverUnrestrictedWhereBranches from "../src/discover-unrestricted-where-branches";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, name), source, "utf8");
};

const discover = () => discoverUnrestrictedWhereBranches(newProject(), workdir);

describe("discover-unrestricted-where-branches", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-where-branch-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags the guard whose deny arm returns {}", () => {
        expect.assertions(4);

        // The exact shape from the adoption that prompted this lint.
        write(
            "shapes.ts",
            `import { defineShape, v } from "@lunora/server";

export const wholeOutline = defineShape({
    args: { userId: v.string() },
    table: "nodes",
    where: (ctx, { userId }) => {
        if (!ctx.auth.userId || ctx.auth.userId !== userId) {
            return {};
        }

        return { userId };
    },
});
`,
        );

        const [branch, ...rest] = discover();

        expect(rest).toStrictEqual([]);
        expect(branch?.exportName).toBe("wholeOutline");
        expect(branch).toMatchObject({ file: "shapes", form: "empty-object", key: "where", owner: "defineShape" });
        // Points at the returned expression, not the enclosing call.
        expect(branch?.line).toBe(8);
    });

    it("flags a ternary arm and a bare `return;`", () => {
        expect.assertions(2);

        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const viaTernary = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.userId ? { userId: ctx.auth.userId } : {}) });
export const viaBareReturn = defineShape({
    table: "nodes",
    where: (ctx) => {
        if (!ctx.auth.userId) {
            return;
        }

        return { userId: ctx.auth.userId };
    },
});
`,
        );

        const forms = discover().map((branch) => `${branch.exportName}:${branch.form}`);

        expect(forms).toContain("viaTernary:empty-object");
        expect(forms).toContain("viaBareReturn:undefined");
    });

    it("flags an RLS policy `when` the same way", () => {
        expect.assertions(1);

        write(
            "policies.ts",
            `import { definePolicy } from "@lunora/server";

export const readOwn = definePolicy({
    on: "read",
    table: "nodes",
    when: ({ auth }) => {
        if (!auth.userId) {
            return {};
        }

        return { userId: auth.userId };
    },
});
`,
        );

        expect(discover()).toMatchObject([{ exportName: "readOwn", key: "when", owner: "definePolicy" }]);
    });

    it("accepts a deny() denial arm", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape, deny, v } from "@lunora/server";

export const wholeOutline = defineShape({
    args: { userId: v.string() },
    table: "nodes",
    where: (ctx, { userId }) => (ctx.auth.userId === userId ? { userId } : deny()),
});
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("accepts a boolean denial arm", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.userId ? { userId: ctx.auth.userId } : false) });
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("leaves a deliberate single-exit replicate-everything shape alone", () => {
        expect.assertions(2);

        // No branch, so `{}` is the author saying "replicate the whole table" — broad,
        // but intentional and legitimate. Flagging it would be noise.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const everything = defineShape({ table: "nodes", where: () => ({}) });
export const alsoEverything = defineShape({
    table: "nodes",
    where: () => {
        return {};
    },
});
`,
        );

        expect(discover()).toStrictEqual([]);
        expect(discover()).toHaveLength(0);
    });

    it("ignores an unrelated call with a where-shaped config", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `const somethingElse = (config: unknown) => config;

export const notAShape = somethingElse({ where: (x: { ok: boolean }) => (x.ok ? { a: 1 } : {}) });
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("returns [] when the lunora dir has no shapes or policies", () => {
        expect.assertions(1);

        write("schema.ts", 'export const schema = "not a shape";\n');

        expect(discover()).toStrictEqual([]);
    });
});
