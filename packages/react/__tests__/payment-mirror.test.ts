/**
 * Drift gate for the `Subscription` mirror in `src/payment.tsx`.
 *
 * The kit re-declares it rather than importing `@lunora/payment`, so this React
 * entry never pulls the server-only payment module graph into a browser bundle.
 * Nothing compared the copies, and the mirror had frozen at the two providers
 * that shipped first (`polar` / `stripe`) while three more adapters landed, and
 * had dropped `currentPeriodStart` — the window metered usage is summed over, so
 * a client without it falls back to `createdAt` and shows LIFETIME usage against
 * a per-period limit. The `provider` value is persisted verbatim, so an app
 * branching on it was routing every Creem/Autumn/Dodo customer down the wrong
 * path.
 *
 * A source-text comparison because the whole point of the mirror is that these
 * two packages must not share a program.
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

/** One `interface X { … }` / `type X = …;` declaration, comments stripped and whitespace collapsed. */
const declarationOf = (relativePath: string, keyword: "interface" | "type", name: string): string => {
    const source = stripComments(readFileSync(join(repoRoot(), relativePath), "utf8"));
    const start = new RegExp(String.raw`^(?:export )?${keyword} ${name}\b`, "m").exec(source);

    if (start === null) {
        throw new Error(`${relativePath}: no \`${keyword} ${name}\` declaration — the mirror moved or was renamed.`);
    }

    const end = keyword === "type" ? source.indexOf(";", start.index) + 1 : source.indexOf("}", start.index) + 1;

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

const MIRROR = "packages/react/src/payment.tsx";
const SOURCE = "packages/payment/src/types.ts";

describe("subscription mirror", () => {
    it("carries every field @lunora/payment declares", () => {
        expect.assertions(1);

        expect(membersOf(MIRROR, "Subscription")).toStrictEqual(membersOf(SOURCE, "Subscription"));
    });

    it("accepts every provider that has an adapter", () => {
        expect.assertions(1);

        expect(declarationOf(MIRROR, "type", "ProviderId")).toBe(declarationOf(SOURCE, "type", "ProviderId"));
    });

    it("accepts every subscription state", () => {
        expect.assertions(1);

        // The mirror inlines the union (there is no second use of it here), so
        // compare it against the named alias' right-hand side.
        const states = declarationOf(SOURCE, "type", "SubscriptionState").split(" = ")[1] ?? "";

        expect(declarationOf(MIRROR, "interface", "Subscription")).toContain(`state: ${states}`);
    });
});
