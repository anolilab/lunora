/**
 * Drift gate for the structural mirrors of two types this package OWNS.
 *
 * Several packages deliberately re-declare `FunctionReference` (and the
 * scheduler's `ScheduleRecord`) instead of importing them, so no runtime
 * dependency edge is created. Nothing compared the copies, and both had rotted
 * in the one way a mirror can rot silently.
 *
 * `@lunora/scheduler` / `@lunora/workflow` mirrored a `_args` phantom that
 * codegen has never emitted. Their `ArgsOf` read it through an OPTIONAL property,
 * which every object type satisfies, so `A` inferred as `unknown` and every
 * scheduled/workflow call took any args at all — silently, because a
 * vacuously-true conditional cannot fail loudly.
 *
 * The `ScheduleRecord` copies required `functionPath`, which the producer omits
 * for a workflow-targeted job, and dropped `workflow` entirely.
 *
 * These are source-text comparisons rather than type-level ones on purpose: the
 * whole point of the mirrors is that these packages cannot import each other, so
 * there is no program in which both types exist. Reading the declarations off
 * disk is the only check available that fails when EITHER side moves.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/** Repo root — resolved by walking up from the vitest project root, which differs per invocation. */
const repoRoot = (): string => {
    let directory = process.cwd();

    while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
        const parent = dirname(directory);

        if (parent === directory) {
            throw new Error("cannot locate the repo root (no pnpm-workspace.yaml above the vitest project root)");
        }

        directory = parent;
    }

    return directory;
};

const stripComments = (source: string): string => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[\t ]*\/\/[^\n]*$/gm, "");

/**
 * Extract one `interface X { … }` / `type X = …;` declaration from a source
 * file, comments stripped and whitespace collapsed, so two copies can be
 * compared verbatim.
 */
const declarationOf = (relativePath: string, keyword: "interface" | "type", name: string): string => {
    const source = stripComments(readFileSync(join(repoRoot(), relativePath), "utf8"));
    const start = new RegExp(String.raw`^(?:export )?${keyword} ${name}\b`, "m").exec(source);

    if (start === null) {
        throw new Error(`${relativePath}: no \`${keyword} ${name}\` declaration — the mirror moved or was renamed.`);
    }

    let end = source.indexOf(";", start.index) + 1;

    if (keyword === "interface") {
        let depth = 0;

        end = source.indexOf("{", start.index);

        for (let index = end; index < source.length; index += 1) {
            if (source[index] === "{") {
                depth += 1;
            } else if (source[index] === "}") {
                depth -= 1;

                if (depth === 0) {
                    end = index + 1;
                    break;
                }
            }
        }
    }

    return source
        .slice(start.index, end)
        .replace(/^export /, "")
        .replaceAll(/\s+/g, " ")
        .trim();
};

/** The `name` / `name?` of every member of a (flat) interface declaration, in source order. */
const membersOf = (relativePath: string, name: string): string[] => {
    const declaration = declarationOf(relativePath, "interface", name);

    return declaration
        .slice(declaration.indexOf("{") + 1, declaration.lastIndexOf("}"))
        .split(";")
        .map((member) => member.trim().replace("readonly ", "").split(":")[0]?.trim() ?? "")
        .filter((member) => member.length > 0);
};

const CLIENT_TYPES = "packages/client/src/types.ts";
const SCHEDULER_TYPES = "packages/scheduler/src/types.ts";
const WORKFLOW_TYPES = "packages/workflow/src/types.ts";

describe("functionReference mirrors", () => {
    it.each([SCHEDULER_TYPES, WORKFLOW_TYPES])("%s declares this package's FunctionReference verbatim", (mirror) => {
        expect.assertions(3);

        expect(declarationOf(mirror, "type", "FunctionKind")).toBe(declarationOf(CLIENT_TYPES, "type", "FunctionKind"));
        expect(declarationOf(mirror, "interface", "FunctionReference")).toBe(declarationOf(CLIENT_TYPES, "interface", "FunctionReference"));
        expect(declarationOf(mirror, "type", "ArgsOf")).toBe(declarationOf(CLIENT_TYPES, "type", "ArgsOf"));
    });

    it("reads the phantom key inference actually depends on", () => {
        expect.assertions(2);

        // Guards the exact failure above: a mirror that reads a key the emit does
        // not carry still compiles, and degrades to `unknown` instead of erroring.
        expect(declarationOf(CLIENT_TYPES, "interface", "FunctionReference")).toContain("__lunoraPhantom?:");
        expect(declarationOf(CLIENT_TYPES, "type", "ArgsOf")).toContain("infer A");
    });
});

describe("scheduleRecord mirrors", () => {
    it("this package's admin-wire ScheduleRecord carries every field the scheduler writes", () => {
        expect.assertions(1);

        // `GET /_lunora/admin/scheduled` proxies the SchedulerDO's `/list` bytes
        // through untouched, so the client type is a FULL mirror — a field missing
        // here is a field the studio cannot render.
        expect(membersOf(CLIENT_TYPES, "ScheduleRecord")).toStrictEqual(membersOf(SCHEDULER_TYPES, "ScheduleRecord"));
    });

    it.each(["packages/shard-engine/src/system-reader.ts", "packages/server/src/types.ts"])(
        "%s's ScheduledFunctionDoc is a faithful subset of it",
        (mirror) => {
            expect.assertions(1);

            // The `ctx.db.system` view surfaces a subset, so this is containment
            // rather than equality — including optionality, which is where
            // `functionPath` had drifted to required and forced a `""` placeholder.
            const source = new Set(membersOf(SCHEDULER_TYPES, "ScheduleRecord"));

            expect(membersOf(mirror, "ScheduledFunctionDoc").filter((member) => !source.has(member))).toStrictEqual([]);
        },
    );
});
