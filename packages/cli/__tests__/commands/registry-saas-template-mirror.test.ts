/**
 * Drift gate for the registry payload the `saas` template ships.
 *
 * A template ships the COMPOSED result of `lunora registry add saas-ui-react`
 * rather than running it at clone time, so `templates/saas/lunora/` holds the
 * files the items would have written, plus the lock (`.lunora-registry.json`)
 * recording what each one was written as. Both halves drift on their own:
 * the copies forked from their items (a `useForm` that mutated a ref during
 * render, a presence heartbeat without its payload caps), and the lock kept
 * hashes of files that had since changed. A stale lock hash is not cosmetic —
 * it is the "base" of the 3-way reconcile, so the first `registry add` in a
 * scaffolded project reads every such file as user-edited and writes `.new`
 * sidecars instead of upgrading it.
 *
 * Both are compared against what the CLI itself would write — `readItemFile`
 * with the umbrella rewrite on, since the template depends on `lunorash` —
 * rather than a hand-copied transform, so the gate cannot agree with a copy
 * the CLI would never produce.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { readItemFile } from "../../src/commands/registry/reconcile";
import type { RegistryFile } from "../../src/commands/registry/types";
import { hashContent } from "../../src/util/registry-lock";

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

const TEMPLATE = join(repoRoot(), "templates", "saas");

/**
 * Files the template deliberately customises after `add` wrote them: `auth`
 * gains the `organization()` / `admin()` plugins the kit's tenancy runs on, and
 * `payment` scopes the subscription to the organisation instead of the user.
 * Their lock hash is still the item's copy — that is what makes a later
 * `registry add` see them as locally edited and leave them alone.
 */
const CUSTOMISED = new Set(["lunora/auth/index.ts", "lunora/payment/index.ts"]);

const lock = JSON.parse(readFileSync(join(TEMPLATE, "lunora", ".lunora-registry.json"), "utf8")) as {
    items: Record<string, { files: Record<string, string> }>;
};

const items = Object.keys(lock.items).toSorted((a, b) => a.localeCompare(b));

const manifestOf = (item: string): { directory: string; files: RegistryFile[] } => {
    const directory = join(repoRoot(), "registry", item);
    const { files } = JSON.parse(readFileSync(join(directory, "registry.json"), "utf8")) as { files: RegistryFile[] };

    return { directory, files };
};

const cases = items.flatMap((item) => {
    const { directory, files } = manifestOf(item);

    return files.map((file) => {
        return { file, incoming: readItemFile(directory, file, true, item), item };
    });
});

describe("saas template mirrors the registry items it was composed from", () => {
    it("covers every item the kit composes (the lock is not vacuously small)", () => {
        expect.assertions(2);

        expect(items).toStrictEqual(expect.arrayContaining(["auth", "payment", "presence", "ratelimit", "saas", "saas-ui-react"]));
        expect(cases.length).toBeGreaterThan(30);
    });

    it.each(cases.filter(({ file }) => file.merge === "create-or-skip"))(
        "the lock records $file.to as the $item item writes it",
        ({ file, incoming, item }) => {
            expect.assertions(1);

            expect(lock.items[item]?.files[file.to]).toBe(hashContent(incoming));
        },
    );

    it.each(cases.filter(({ file }) => !CUSTOMISED.has(file.to)))("$file.to is what the $item item writes", ({ file, incoming }) => {
        expect.assertions(1);

        expect(readFileSync(join(TEMPLATE, file.to), "utf8")).toBe(incoming);
    });

    it("the lock names no file its item does not write", () => {
        expect.assertions(1);

        const written = new Set(cases.map(({ file, item }) => `${item}:${file.to}`));
        const recorded = items.flatMap((item) => Object.keys(lock.items[item]?.files ?? {}).map((to) => `${item}:${to}`));

        expect(recorded.filter((entry) => !written.has(entry))).toStrictEqual([]);
    });

    it("lunora/saas-ui holds only what saas-ui-react writes", () => {
        expect.assertions(1);

        const directory = join(TEMPLATE, "lunora", "saas-ui");
        const shipped = readdirSync(directory, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => join("lunora", "saas-ui", relative(directory, join(entry.parentPath, entry.name))));
        const expected = new Set(manifestOf("saas-ui-react").files.map(({ to }) => to));

        expect(shipped.filter((file) => !expected.has(file))).toStrictEqual([]);
    });
});
