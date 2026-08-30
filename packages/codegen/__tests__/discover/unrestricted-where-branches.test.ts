import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverUnrestrictedWhereBranches from "../../src/discover/unrestricted-where-branches";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const write = (name: string, source: string): void => {
    writeFileSync(join(workdir, name), source, "utf8");
};

const discover = () => discoverUnrestrictedWhereBranches(newProject(), workdir);

describe("discover/unrestricted-where-branches", () => {
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

    it("leaves the mirror allow-position ternary alone (admin sees everything)", () => {
        expect.assertions(1);

        // `{}` on the TRUE arm of a positive condition is the intentional "no further
        // restriction" for admins, not the deny arm — the false positive this fix removes.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.isAdmin ? {} : { userId: ctx.auth.userId }) });
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("flags an if-return-plus-fallthrough guard whose deny arm returns {} (positive orientation)", () => {
        expect.assertions(1);

        // The if-branch fires when the negative-shaped condition is true (not logged
        // in) — that IS the deny arm, same bug as the ternary case, if-form idiom.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({
    table: "nodes",
    where: (ctx) => {
        if (!ctx.auth.userId) return {};

        return { userId: ctx.auth.userId };
    },
});
`,
        );

        expect(discover()).toMatchObject([{ exportName: "s", form: "empty-object", key: "where", owner: "defineShape" }]);
    });

    it("leaves the if-return-plus-fallthrough mirror alone (admin sees everything)", () => {
        expect.assertions(1);

        // If-branch fires for the positive condition (isAdmin) and returns `{}` — the
        // intentional allow-everything arm, mirroring the ternary case above.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({
    table: "nodes",
    where: (ctx) => {
        if (ctx.auth.isAdmin) return {};

        return { userId: ctx.auth.userId };
    },
});
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("flags the `=== undefined` deny guard in ternary form", () => {
        expect.assertions(1);

        // `ctx.auth.userId === undefined` is the same assertion as `!ctx.auth.userId`,
        // so the TRUE arm is the deny arm — reading `===` as positive classified `{}`
        // as the allow arm and let a full-table replication for anonymous callers pass.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.userId === undefined ? {} : { userId: ctx.auth.userId }) });
`,
        );

        expect(discover()).toMatchObject([{ exportName: "s", form: "empty-object", key: "where", owner: "defineShape" }]);
    });

    it("flags the `=== null` deny guard in if-statement early-return form", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({
    table: "nodes",
    where: (ctx) => {
        if (ctx.auth.userId === null) {
            return {};
        }

        return { userId: ctx.auth.userId };
    },
});
`,
        );

        expect(discover()).toMatchObject([{ exportName: "s", form: "empty-object", key: "where", owner: "defineShape" }]);
    });

    it("flags a `=== false` deny guard and leaves its `!== undefined` mirror alone", () => {
        expect.assertions(2);

        // `!== undefined` asserts presence, so its `{}` sits on the intentional allow
        // side — the inverted equality must flip both operators, not just `===`.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const denied = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.isMember === false ? {} : { userId: ctx.auth.userId }) });
export const mirror = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.userId !== undefined ? {} : { userId: "none" }) });
`,
        );

        const forms = discover().map((branch) => `${branch.exportName}:${branch.form}`);

        expect(forms).toContain("denied:empty-object");
        expect(forms).not.toContain("mirror:empty-object");
    });

    it("still reads `===` between two non-nullish operands as positive", () => {
        expect.assertions(1);

        // The pre-existing classification: `{}` on the FALSE arm of an identity check is
        // the deny arm, and `{}` on its TRUE arm is not. Both must survive the flip.
        write(
            "shapes.ts",
            `import { defineShape, v } from "@lunora/server";

export const denyArm = defineShape({
    args: { userId: v.string() },
    table: "nodes",
    where: (ctx, { userId }) => (ctx.auth.userId === userId ? { userId } : {}),
});
export const allowArm = defineShape({
    args: { userId: v.string() },
    table: "nodes",
    where: (ctx, { userId }) => (ctx.auth.userId === userId ? {} : { userId }),
});
`,
        );

        expect(discover()).toMatchObject([{ exportName: "denyArm", form: "empty-object", key: "where", owner: "defineShape" }]);
    });

    it("reads no polarity from a comparison against a role literal", () => {
        expect.assertions(1);

        // `!== "guest"` is an ALLOW check written with the operator that reads as a
        // denial for an identity match, and `=== "admin"` is one written with the
        // operator that reads as an allow. The literal is what makes the operator
        // meaningless here, so neither `{}` may be called a deny arm.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const notGuest = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.role !== "guest" ? {} : { userId: ctx.auth.userId }) });
export const isAdmin = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.role === "admin" ? { userId: ctx.auth.userId } : {}) });
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("leaves an arm returning allowAll() alone even in the deny position", () => {
        expect.assertions(1);

        // `allowAll()` sits on the ternary's false arm — structurally the deny
        // candidate — but it is an explicit, intentional marker and must never flag.
        write(
            "shapes.ts",
            `import { allowAll, defineShape } from "@lunora/server";

export const s = defineShape({ table: "nodes", where: (ctx) => (ctx.auth.userId ? { userId: ctx.auth.userId } : allowAll()) });
`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("resolves an aliased defineShape import", () => {
        expect.assertions(1);

        write(
            "shapes.ts",
            `import { defineShape as shape } from "@lunora/server";

export const s = shape({
    table: "nodes",
    where: (ctx) => {
        if (!ctx.auth.userId) {
            return {};
        }

        return { userId: ctx.auth.userId };
    },
});
`,
        );

        expect(discover()).toMatchObject([{ exportName: "s", key: "where", owner: "defineShape" }]);
    });

    it("ignores a nested callback's returns, which are not predicate exits", () => {
        expect.assertions(1);

        // The predicate itself has ONE exit, so it isn't a guard. The `{}` belongs to a
        // helper callback — treating it as a branch arm would be a false positive.
        write(
            "shapes.ts",
            `import { defineShape } from "@lunora/server";

export const s = defineShape({
    table: "nodes",
    where: (ctx) => {
        const extra = ["a"].map((key) => {
            if (key === "a") {
                return {};
            }

            return { key };
        });

        return { AND: extra, userId: ctx.auth.userId };
    },
});
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
