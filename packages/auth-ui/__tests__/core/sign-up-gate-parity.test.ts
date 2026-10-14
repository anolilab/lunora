import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The server can close self-serve sign-up
 * (`emailAndPassword.disableSignUp`), the client resolves it onto
 * `ControllerContext.signUp`, and every port is meant to read it in three
 * places: the sign-up card, the sign-up route, and the sign-in footer link
 * (plan 278). `credentials` — the field right beside it in `config.ts` — got
 * this wiring in all five ports; `signUp` didn't, silently, until this plan.
 *
 * This test is the drift-stopper `credentials` never had: it fails if any
 * port's source tree stops containing a genuine context read of `signUp`.
 * Each port's regex is written to match only a *context* read (`context.signUp`,
 * `context.value.signUp`, `this.context().signUp`, …) — never `t.signUp`
 * (localization), `viewPaths.signUp` (the URL segment), or `signUpHref` (a
 * plain link prop), any of which would satisfy a naive `\bsignUp\b` scan
 * without the app ever gating anything on the resolved flag.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_UI_SRC = join(HERE, "..", "..", "src");

const TS_FILE_RE = /\.(?:svelte|tsx?|vue)$/;

/** Every source file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            return filesUnder(full);
        }

        return TS_FILE_RE.test(entry.name) ? [full] : [];
    });

/**
 * Per-port pattern for a genuine *context read* of the resolved `signUp` flag.
 * Deliberately narrow — a prefix that only a real context access produces —
 * rather than a bare `\bsignUp\b`, which `viewPaths.signUp` and `t.signUp`
 * would also satisfy.
 */
const PORT_PATTERNS: Record<string, RegExp> = {
    angular: /this\.context\(\)\.signUp\b/,
    react: /context\.signUp\b/,
    solid: /context\.signUp\b/,
    svelte: /context\.signUp\b/,
    vue: /context\.(?:value\.)?signUp\b/,
};

const hasContextRead = (port: string): boolean => {
    const pattern = PORT_PATTERNS[port];

    if (pattern === undefined) {
        return false;
    }

    return filesUnder(join(AUTH_UI_SRC, port)).some((file) => pattern.test(readFileSync(file, "utf8")));
};

describe("signUp × port parity", () => {
    it.each(Object.keys(PORT_PATTERNS))("%s reads context.signUp somewhere in its source tree", (port) => {
        expect.assertions(1);

        expect(hasContextRead(port), `no file under src/${port} contains a context read of signUp matching ${String(PORT_PATTERNS[port])}`).toBe(true);
    });

    it("the pattern list does not vacuously match localization, viewPaths, or href references", () => {
        expect.assertions(Object.keys(PORT_PATTERNS).length * 3);

        for (const pattern of Object.values(PORT_PATTERNS)) {
            expect(pattern.test("t.signUp")).toBe(false);
            expect(pattern.test("viewPaths.signUp")).toBe(false);
            expect(pattern.test("signUpHref")).toBe(false);
        }
    });
});
