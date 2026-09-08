import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = join(here, "..", "..", "..", "server", "src");
const discoverer = join(here, "..", "..", "src", "discover", "unregistered-procedures.ts");

/**
 * `RegisteredFunction` is the base interface the others are built from, never a
 * terminal a registration lands on by itself, so it is not a table row.
 */
const BASE_TYPE = "RegisteredFunction";

/** Every `Registered*` type `@lunora/server` declares, from its source. */
const declaredRegistrationTypes = (): string[] => {
    const names = new Set<string>();

    for (const file of ["types.ts", "reactors.ts"]) {
        const source = readFileSync(join(serverSource, file), "utf8");

        for (const match of source.matchAll(/^(?:export )?(?:type|interface) (Registered\w+)/gm)) {
            if (match[1] !== undefined && match[1] !== BASE_TYPE) {
                names.add(match[1]);
            }
        }
    }

    return [...names].toSorted((a, b) => a.localeCompare(b));
};

describe("registration-type parity (anti-drift lock for the dropped-procedure check)", () => {
    it("keeps `unregistered-procedures.ts` exhaustive over `@lunora/server`'s Registered* types", () => {
        expect.assertions(2);

        // A registration type absent from that table is a shape the check drops
        // in total silence — which is the defect the check exists to end, so a
        // new one has to fail here rather than in a user's app. `RegisteredStream`
        // was missing exactly this way: a dropped `.stream()` procedure went
        // unreported, and a stream-only app was told to fix a healthy tsconfig
        // (#651). A new `Registered*` type means one new row.
        const declared = declaredRegistrationTypes();
        const source = readFileSync(discoverer, "utf8");

        // Sanity: the scrape found the known set, so a rename upstream cannot
        // make this test vacuously pass.
        expect(declared).toStrictEqual([
            "RegisteredAction",
            "RegisteredLifecycleHook",
            "RegisteredMutation",
            "RegisteredQuery",
            "RegisteredReactor",
            "RegisteredStream",
        ]);
        expect(declared.filter((name) => !source.includes(`"${name}"`))).toStrictEqual([]);
    });
});
