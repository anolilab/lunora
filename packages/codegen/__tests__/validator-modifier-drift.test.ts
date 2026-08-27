/**
 * Anti-drift lock between `parse-validator.ts`'s modifier sets and the chainable
 * surface `@lunora/values` publishes.
 *
 * The failure mode of drift here is not a degraded type — it is
 * `throw new LunoraError("INTERNAL", "Unsupported validator kind: <name>")`, which
 * aborts the whole run. A `.uuid()` added to `StringColumnValidator` and forgotten
 * here bricks codegen for every app that adopts it: no dev, no build, no deploy.
 * That is exactly how `.max()` and `.serverDefault()` shipped broken, so the list
 * is locked to its source rather than maintained by hand.
 *
 * Mirrors the `UMBRELLA_BASE_PACKAGES` lock in `run-codegen.test.ts`, which exists
 * for the same reason and was written after the same kind of omission.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { COLUMN_MODIFIERS, METADATA_MODIFIERS, REFINEMENT_MODIFIERS } from "../src/parse-validator";

const here = dirname(fileURLToPath(import.meta.url));
const VALIDATOR_SOURCE = join(here, "..", "..", "values", "src", "v.ts");

/**
 * Every method name declared on a `*ColumnValidator` interface in `v.ts` — the
 * chainable surface, i.e. exactly what can appear as `.<name>(…)` after a
 * `v.<factory>()` call. The base `Validator`/`Column` interfaces are excluded on
 * purpose: `parse`/`safeParse`/`kind` are not part of a construction chain.
 */
const publishedModifiers = (): ReadonlySet<string> => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const file = project.addSourceFileAtPath(VALIDATOR_SOURCE);
    const names = new Set<string>();

    for (const iface of file.getInterfaces()) {
        // `Internal*` twins carry the same names and would only duplicate.
        if (!iface.getName().endsWith("ColumnValidator") || iface.getName().startsWith("Internal")) {
            continue;
        }

        for (const member of [...iface.getProperties(), ...iface.getMethods()]) {
            names.add(member.getName());
        }
    }

    return names;
};

describe("validator modifier drift", () => {
    it("reads a non-empty chainable surface out of `@lunora/values`", () => {
        expect.assertions(2);

        // Guards the lock itself: a moved file or a renamed interface would make
        // both directions below pass vacuously over an empty set.
        expect(readFileSync(VALIDATOR_SOURCE, "utf8")).toContain("interface StringColumnValidator");
        expect(publishedModifiers().size).toBeGreaterThan(10);
    });

    it("knows every modifier `@lunora/values` publishes", () => {
        expect.assertions(1);

        const known = new Set([...COLUMN_MODIFIERS, ...REFINEMENT_MODIFIERS, ...METADATA_MODIFIERS]);
        const unknown = [...publishedModifiers()].filter((name) => !known.has(name)).toSorted((a, b) => a.localeCompare(b));

        // Anything listed here aborts `lunora codegen` the moment an app uses it.
        expect(unknown).toStrictEqual([]);
    });

    it("does not claim modifiers `@lunora/values` no longer publishes", () => {
        expect.assertions(1);

        const published = publishedModifiers();
        const stale = [...COLUMN_MODIFIERS, ...REFINEMENT_MODIFIERS, ...METADATA_MODIFIERS]
            .filter((name) => !published.has(name))
            .toSorted((a, b) => a.localeCompare(b));

        expect(stale).toStrictEqual([]);
    });

    it("keeps the three sets disjoint — a modifier has exactly one effect", () => {
        expect.assertions(1);

        const all = [...COLUMN_MODIFIERS, ...REFINEMENT_MODIFIERS, ...METADATA_MODIFIERS];

        expect(all).toHaveLength(new Set(all).size);
    });
});
