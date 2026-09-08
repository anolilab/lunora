import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..", "..");
const discoverer = join(here, "..", "..", "src", "discover", "unregistered-procedures.ts");

/**
 * `Registered*` types that are deliberately NOT rows, with the reason each one
 * is not a registration a user exports from `lunora/`.
 */
const NOT_REGISTRATIONS = new Set([
    // Shapes of codegen's OWN generated metadata (emit.ts), not user-facing APIs.
    "RegisteredDataMigration",
    // The base interface the procedure aliases are built from — never a terminal on its own.
    "RegisteredFunction",
    "RegisteredLunoraFunction",
    // Internal to `@lunora/mcp`'s paid-tool bookkeeping.
    "RegisteredTool",
]);

const DECLARATION = /^(?:export )?(?:type|interface) (Registered\w+)/gm;

/** Every `.ts` file under `directory`, skipping build output and dependencies. */
const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
        }

        return entry.name.endsWith(".ts") ? [path] : [];
    });

/** Each workspace package's `src`, for the packages that have one. */
const packageSources = (): string[] =>
    readdirSync(packages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packages, entry.name, "src"))
        .filter((path) => existsSync(path));

/** Every `Registered*` type declared anywhere in the workspace, minus the non-registrations. */
const declaredRegistrationTypes = (): string[] => {
    const names = new Set<string>();

    for (const file of packageSources().flatMap((directory) => sourceFiles(directory))) {
        for (const [, name] of readFileSync(file, "utf8").matchAll(DECLARATION)) {
            if (name !== undefined && !NOT_REGISTRATIONS.has(name)) {
                names.add(name);
            }
        }
    }

    return [...names].toSorted((a, b) => a.localeCompare(b));
};

describe("registration-type parity (anti-drift lock for the dropped-registration check)", () => {
    it("keeps `unregistered-procedures.ts` exhaustive over every `Registered*` type", () => {
        expect.assertions(2);

        // A registration type absent from that table is a shape the check drops
        // in total silence — which is the defect the check exists to end, so a
        // new one has to fail here rather than in a user's app. `RegisteredStream`
        // was missing exactly this way: a dropped `.stream()` procedure went
        // unreported, and a stream-only app was told to fix a healthy tsconfig
        // (#651).
        //
        // A new type needs BOTH a row and its identity in `Registrations` — a row
        // alone reports every healthy export of that kind as dropped. If the
        // identity is not available (as for crons, whose IR records no exporting
        // binding), add the name to `NOT_REGISTRATIONS` with the reason instead.
        const declared = declaredRegistrationTypes();
        const source = readFileSync(discoverer, "utf8");

        // Sanity: the scrape found the known set, so a rename upstream cannot
        // make this test vacuously pass.
        expect(declared).toStrictEqual([
            "RegisteredAction",
            "RegisteredLifecycleHook",
            "RegisteredMigration",
            "RegisteredMutation",
            "RegisteredMutator",
            "RegisteredQuery",
            "RegisteredReactor",
            "RegisteredShape",
            "RegisteredStream",
        ]);
        expect(declared.filter((name) => !source.includes(`"${name}"`))).toStrictEqual([]);
    });

    it("covers the `*Definition` types the `define*` APIs return", () => {
        expect.assertions(1);

        // These four do not follow the `Registered*` naming the scrape above
        // keys on, so they are pinned by name: `defineWorkflow`, `defineQueue`,
        // `defineAgent` and `defineContainer` each return one.
        const source = readFileSync(discoverer, "utf8");
        const expected = ["AgentDefinition", "ContainerDefinition", "QueueDefinition", "WorkflowDefinition"];

        expect(expected.filter((name) => !source.includes(`"${name}"`))).toStrictEqual([]);
    });
});
