/**
 * Drift gate for the `saas-ui-react` payload the `saas` template ships.
 *
 * `templates/saas/lunora/saas-ui/` is a verbatim copy of
 * `registry/saas-ui-react/` — a template ships the COMPOSED result rather than
 * running `lunora registry add` at clone time, so the files the item would have
 * written are checked in instead. Nothing compared them, and they forked
 * immediately: the template kept a `useForm` that mutated a ref during render,
 * a `createProjectFormController` without `resetOnSuccess`, and the barrel
 * imports whose cycle produced the TDZ crash the item had already been fixed
 * for. Every project started from the template would have carried all three.
 *
 * This is the same failure the payment mirror gate exists for
 * (`registry-payment-mirror.test.ts`), one directory over. A byte comparison is
 * the right assertion here because the copy IS verbatim — the template's
 * `lunora/saas-ui/` sits at the same depth the item writes into, so even the
 * relative imports match.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

const CANONICAL = "registry/saas-ui-react";
const COPY = "templates/saas/lunora/saas-ui";

/** Every file under `directory`, as paths relative to it, in stable order. */
const filesUnder = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
        .toSorted((a, b) => a.localeCompare(b));

/**
 * The item's own manifest and README describe the registry entry, not the
 * scaffolded project, so `registry add` never writes them.
 */
const ITEM_ONLY = new Set(["README.md", "registry.json"]);

describe("saas template mirrors the saas-ui-react registry item", () => {
    const canonicalRoot = join(repoRoot(), CANONICAL);
    const expected = filesUnder(canonicalRoot).filter((file) => !ITEM_ONLY.has(file));

    it("ships every file the item writes, and no others", () => {
        expect.assertions(1);

        expect(filesUnder(join(repoRoot(), COPY))).toStrictEqual(expected);
    });

    it.each(expected)("%s is byte-identical to the item's copy", (file) => {
        expect.assertions(1);

        expect(readFileSync(join(repoRoot(), COPY, file), "utf8")).toBe(readFileSync(join(canonicalRoot, file), "utf8"));
    });

    it("reads a non-trivial file set (the walker is not vacuously passing)", () => {
        expect.assertions(2);

        // A walker that silently returned `[]` would make every case above pass
        // against an empty directory. Pin one known file and a plausible count.
        expect(expected).toContain(join("react", "use-form.ts"));
        expect(expected.length).toBeGreaterThan(20);
    });
});
