/**
 * The resolver `registry/saas/identity.ts` documents is the one an app copies
 * into a Worker that is not the saas template, so it has to set the same
 * membership-checked tenant claims as the template's real resolver. It once
 * left out `orgId`, which `lunora/presence` scopes rooms by: an app that copied
 * it put every organization in one presence room.
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

/** Claims a resolver derives from the `member` lookup, i.e. the ones gated on membership. */
const membershipClaims = (source: string, linePrefix: string): string[] =>
    [...source.matchAll(new RegExp(String.raw`^${linePrefix}(\w+): member\b`, "gmu"))].map((match) => match[1] ?? "").toSorted((a, b) => a.localeCompare(b));

describe("saas identity contract docs", () => {
    it("documents a resolver that sets every membership-checked claim the template's resolver sets", () => {
        expect.assertions(2);

        const documented = membershipClaims(readFileSync(join(repoRoot(), "registry", "saas", "identity.ts"), "utf8"), String.raw`\s*\*\s+`);
        const real = membershipClaims(readFileSync(join(repoRoot(), "templates", "saas", "lunora", "server.ts"), "utf8"), String.raw`\s+`);

        expect(real).toContain("orgId");
        expect(documented).toStrictEqual(real);
    });
});
