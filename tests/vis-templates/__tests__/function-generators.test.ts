import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as lunoraServer from "@lunora/server";
import type { Template } from "@visulima/vis/generate";
import { describe, expect, test } from "vitest";

import actionTemplate from "../../../.vis/templates/lunora-action.js";
import httpRouteTemplate from "../../../.vis/templates/lunora-http-route.js";
import mutationTemplate from "../../../.vis/templates/lunora-mutation.js";
import queryTemplate from "../../../.vis/templates/lunora-query.js";

/**
 * Every named import a function generator writes must resolve in a scaffolded app.
 *
 * The query/mutation/action generators once imported their builder from
 * `lunorash/server`, which re-exports `@lunora/server` — and that package has no
 * `query`/`mutation`/`action` export: the per-app builders are emitted by codegen
 * into `_generated/server`. Every generated file failed to load with "does not
 * provide an export named 'mutation'", and nothing here noticed because no test
 * looked past the file name.
 */

const here = dirname(fileURLToPath(import.meta.url));
// The emitter's golden output for `_generated/server.ts` — regenerated whenever
// codegen changes what that module exports, so it is the list an app gets.
const generatedServer = readFileSync(
    resolve(here, "..", "..", "..", "packages", "codegen", "__tests__", "fixtures", "simple", "expected", "_generated", "server.ts"),
    "utf8",
);
const generatedServerExports = new Set([...generatedServer.matchAll(/^export const (\w+)/gmu)].map((match) => match[1]));

/** What each import specifier a generator may use actually exports. */
const exportsOf: Record<string, (name: string) => boolean> = {
    "#lunora/_generated/server.js": (name) => generatedServerExports.has(name),
    "lunorash/server": (name) => name in lunoraServer,
};

const generate = async (template: Template): Promise<string> => {
    const creation = await template.produce({
        builtins: { dest_dir: here, dest_rel_dir: ".", working_dir: here, workspace_root: here },
        options: { fileNameCase: "camel", name: "probe" },
    });
    const file = (creation.files?.["lunora"] as Record<string, unknown> | undefined)?.["probe.ts"];

    if (typeof file !== "string") {
        throw new TypeError(`${template.about.name} did not produce lunora/probe.ts`);
    }

    return file;
};

describe("function generators write imports that resolve", () => {
    test("the golden _generated/server.ts was parsed", () => {
        expect.assertions(1);

        // A regex that stopped matching would make every check below vacuous.
        expect([...generatedServerExports]).toStrictEqual(expect.arrayContaining(["action", "mutation", "query", "v"]));
    });

    test.each([
        ["lunora-query", queryTemplate, "query"],
        ["lunora-mutation", mutationTemplate, "mutation"],
        ["lunora-action", actionTemplate, "action"],
        ["lunora-http-route", httpRouteTemplate, "httpRoute"],
    ])("%s", async (_name, template, builder) => {
        expect.hasAssertions();

        const source = await generate(template);
        const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gu)].flatMap((match) =>
            match[1]!.split(",").map((name) => ({ name: name.trim(), specifier: match[2]! })),
        );

        expect(imports.map(({ name }) => name)).toContain(builder);

        for (const { name, specifier } of imports) {
            const resolves = exportsOf[specifier];

            expect(resolves, `unexpected import specifier ${specifier}`).toBeDefined();
            expect(resolves!(name), `${specifier} has no export named '${name}'`).toBe(true);
        }
    });
});
