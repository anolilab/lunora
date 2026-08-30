import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Codepoint order — the order the expected lists below are written in; `localeCompare` interleaves case differently. */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

/**
 * `@lunora/react-native` re-exports the `@lunora/react` surface, minus the
 * payment components.
 *
 * The exclusion is the point: `CheckoutButton`, `CustomerPortalButton` and
 * `useCheckout` render a DOM `<button>` and navigate via `globalThis.location`,
 * neither of which exists on a phone — so while the barrel said
 * `export * from "@lunora/react"` they were published in the React Native
 * surface and threw at render / call time on the only platform this package
 * targets.
 *
 * Replacing the star with an explicit list fixes that but introduces the
 * opposite risk: a hook added to `@lunora/react` silently never reaching React
 * Native. This test pins both directions — the RN list is exactly React's
 * barrel minus the payment module's exports, no more and no less.
 *
 * Both barrels are read as source text rather than imported, because importing
 * `@lunora/react` here would resolve its built `dist/` (which a plain
 * per-package test run does not rebuild). The name extraction is a regex over
 * `export … { … } from "…"` blocks, whose one blind spot is `export * from`;
 * the first assertion below is that neither barrel contains one, so the blind
 * spot cannot go unnoticed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(HERE, "..", "..");

/**
 * Strip block and line comments before any pattern runs over the source. The
 * `export *` sentinel below is a regex over raw text, and the native barrel's
 * own comment explains why the list is explicit *rather than*
 * `export * from "@lunora/react"` — so an unstripped read matches the prose
 * describing the hazard instead of the hazard, and the sentinel fails on
 * correct code. Strings are not parsed out; no barrel here contains a module
 * specifier with `//` or `/*` in it.
 */
const stripComments = (source: string): string => source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");

const REACT_BARREL = stripComments(readFileSync(join(PACKAGES_ROOT, "react", "src", "index.ts"), "utf8"));
const NATIVE_BARREL = stripComments(readFileSync(join(PACKAGES_ROOT, "react-native", "src", "index.ts"), "utf8"));

const EXPORT_BLOCK = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";/gu;

/** Every name a barrel re-exports, restricted to statements whose source module matches `fromModule`. */
const exportedNames = (source: string, fromModule?: (module: string) => boolean): Set<string> => {
    const names = new Set<string>();

    for (const [, block, module] of source.matchAll(EXPORT_BLOCK)) {
        if (fromModule && !fromModule(module ?? "")) {
            continue;
        }

        for (const raw of (block ?? "").split(",")) {
            const specifier = raw.replaceAll(/\s+/gu, " ").trim();

            if (specifier === "") {
                continue;
            }

            // `type X` inside a value block, and `default as useAuth` aliases —
            // the name an importer actually writes is what matters.
            const withoutTypeKeyword = specifier.startsWith("type ") ? specifier.slice(5).trim() : specifier;

            names.add(withoutTypeKeyword.includes(" as ") ? (withoutTypeKeyword.split(" as ").at(-1) ?? "").trim() : withoutTypeKeyword);
        }
    }

    return names;
};

const PAYMENT_EXPORTS = exportedNames(REACT_BARREL, (module) => module === "./payment");
const REACT_EXPORTS = exportedNames(REACT_BARREL);
const NATIVE_FROM_REACT = exportedNames(NATIVE_BARREL, (module) => module === "@lunora/react");

describe("react-native surface parity with @lunora/react", () => {
    it("neither barrel uses `export *`, which the name extraction cannot see through", () => {
        expect.assertions(2);

        expect(REACT_BARREL).not.toMatch(/export\s+\*/u);
        expect(NATIVE_BARREL).not.toMatch(/export\s+\*/u);
    });

    it("excludes the web-only payment exports", () => {
        expect.assertions(2);

        // Guards the regression: on a phone `<CheckoutButton>` throws at render and
        // `useCheckout().checkout()` throws reaching `globalThis.location`.
        expect([...PAYMENT_EXPORTS].toSorted(byCodepoint)).toStrictEqual([
            "CheckoutButton",
            "CheckoutButtonProps",
            "CustomerPortalButton",
            "CustomerPortalButtonProps",
            "RedirectTarget",
            "RedirectTrigger",
            "Subscription",
            "UseCheckoutResult",
            "useCheckout",
        ]);
        expect([...NATIVE_FROM_REACT].filter((name) => PAYMENT_EXPORTS.has(name))).toStrictEqual([]);
    });

    it("re-exports everything else React ships, so a new hook cannot go missing here", () => {
        expect.assertions(1);

        const expected = [...REACT_EXPORTS].filter((name) => !PAYMENT_EXPORTS.has(name)).toSorted(byCodepoint);

        expect([...NATIVE_FROM_REACT].toSorted(byCodepoint)).toStrictEqual(expected);
    });
});
