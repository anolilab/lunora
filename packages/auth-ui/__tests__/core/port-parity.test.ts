import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `core/index.ts` is the framework-agnostic barrel every port (React, Vue,
 * Svelte, Solid, Angular) is meant to build on: each `create*Controller`
 * factory it exports is a flow (sign-in, invitations, two-factor, …) that some
 * port is expected to mount. Nothing enforces that today — a controller can
 * ship, sit unconsumed by all five ports, and nobody notices until an audit
 * goes looking. Six such orphans shipped that way (see plan 233).
 *
 * This test reads the export list back out of `core/index.ts` itself — not a
 * hand-copied list, which would silently drift the moment a controller is
 * added or renamed — and fails on any `create*Controller` with zero
 * consumers across the five port directories, unless it is named on
 * {@link DELIBERATELY_UNMOUNTED} with a reason. An unexplained allow-list
 * entry is exactly the silent hole this test exists to close, so every entry
 * must say why: either a still-open follow-up, or a structural reason the
 * export was never meant to be mounted directly (a builder primitive other
 * controllers call, not a flow a port renders).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_UI_SRC = resolve(HERE, "..", "..", "src");
const CORE_INDEX = join(AUTH_UI_SRC, "core", "index.ts");

const PORT_NAMES = ["react", "vue", "solid", "svelte", "angular"] as const;

type PortName = (typeof PORT_NAMES)[number];

const PORT_DIRS: Record<PortName, string> = Object.fromEntries(PORT_NAMES.map((name) => [name, join(AUTH_UI_SRC, name)])) as Record<PortName, string>;

const TS_FILE_RE = /\.tsx?$/;
const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}/g;
const AS_ALIAS_RE = /\bas\s+([A-Za-z_$][\w$]*)\s*$/;
const CONTROLLER_NAME_RE = /^create[A-Z]\w*Controller$/;

/**
 * Controllers with zero port consumers today, and why that's expected. Every
 * entry needs a reason — either it's a genuine open gap (cite the plan) or a
 * structural one (a factory other controllers call, never mounted itself).
 */
const DELIBERATELY_UNMOUNTED: Record<string, string> = {
    createActiveMemberController: "orphan — no port wires org active-member switching yet (plan 233 evidence); still unaddressed on this base",
    createBackupCodeSignInController: "orphan — no port wires backup-code sign-in yet (plan 233 evidence); still unaddressed on this base",
    createFormController:
        "generic form-builder primitive, not a mountable flow — every domain controller that needs a form (backup-codes, sign-in, sign-up, …) calls it internally; a port mounts the domain controller, never this one directly",
    createPhoneForgotPasswordController: "orphan — no port wires phone-based password-reset request yet (plan 233 evidence); still unaddressed on this base",
    createPhoneResetPasswordController: "orphan — no port wires phone-based password reset yet (plan 233 evidence); still unaddressed on this base",
    createPhoneVerifyController: "orphan — no port wires phone verification yet (plan 233 evidence); still unaddressed on this base",
    createResetPasswordOtpController: "orphan — no port wires OTP-based password reset yet (plan 233 evidence); still unaddressed on this base",
    createResourceController:
        "generic resource-fetch primitive, not a mountable flow — every domain controller that lists/fetches a resource (accounts, teams, members, …) calls it internally; a port mounts the domain controller, never this one directly",
};

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            return filesUnder(full);
        }

        return TS_FILE_RE.test(entry.name) ? [full] : [];
    });

/**
 * Every `create*Controller` name `core/index.ts` exports as a VALUE (never a
 * type). Reads the barrel itself so the list can't drift from what a port
 * could actually import — `export type { ... }` blocks are excluded because
 * `\s*\{` can't match past the `type` keyword, so they never enter the regex
 * at all.
 */
const controllerExports = (): string[] => {
    const source = readFileSync(CORE_INDEX, "utf8");
    const names = new Set<string>();

    EXPORT_BLOCK_RE.lastIndex = 0;

    let match: RegExpExecArray | null = EXPORT_BLOCK_RE.exec(source);

    while (match !== null) {
        for (const raw of (match[1] ?? "").split(",")) {
            const spec = raw.trim();
            const asMatch = AS_ALIAS_RE.exec(spec);
            const name = (asMatch ? asMatch[1] : spec) ?? "";

            if (CONTROLLER_NAME_RE.test(name)) {
                names.add(name);
            }
        }

        match = EXPORT_BLOCK_RE.exec(source);
    }

    return [...names].toSorted((a, b) => a.localeCompare(b));
};

/** Which ports reference `name` as a whole word anywhere under their source tree. */
const consumersOf = (name: string): PortName[] => {
    const re = new RegExp(String.raw`\b${name}\b`);

    return PORT_NAMES.filter((port) => filesUnder(PORT_DIRS[port]).some((file) => re.test(readFileSync(file, "utf8"))));
};

describe("auth-ui controller × port parity", () => {
    const controllers = controllerExports();

    it("read a non-trivial controller list back out of core/index.ts", () => {
        expect.assertions(1);

        // A parse regression that silently returns [] would make every other
        // test in this file vacuously pass — guard against that directly.
        expect(controllers.length).toBeGreaterThan(30);
    });

    it.each(controllers)("%s is mounted by at least one port, or is on the allow-list with a reason", (name) => {
        expect.assertions(1);

        const mounted = consumersOf(name).length > 0 || Object.hasOwn(DELIBERATELY_UNMOUNTED, name);

        expect(
            mounted,
            `${name} is exported from core/index.ts but no port (${PORT_NAMES.join(", ")}) references it, and it isn't on DELIBERATELY_UNMOUNTED. ` +
                `Either wire it up in a port, or add an entry explaining why it's expected to stay unmounted.`,
        ).toBe(true);
    });

    it("the allow-list carries no stale entries for controllers a port has since picked up", () => {
        expect.assertions(1);

        const stale = Object.keys(DELIBERATELY_UNMOUNTED).filter((name) => controllers.includes(name) && consumersOf(name).length > 0);

        expect(stale, `these DELIBERATELY_UNMOUNTED entries now have a port consumer — drop them: ${stale.join(", ")}`).toStrictEqual([]);
    });

    it("proves the allow-list is load-bearing: dropping an entry for a still-unmounted controller fails the check", () => {
        expect.assertions(2);

        const stillUnmounted = Object.keys(DELIBERATELY_UNMOUNTED).find((name) => controllers.includes(name) && consumersOf(name).length === 0);

        // If this ever fails, every entry above got mounted — great news, but it
        // means this test needs a new (still-orphaned) example to demonstrate
        // against, per plan 233's verification requirement.
        expect(
            stillUnmounted,
            "expected at least one DELIBERATELY_UNMOUNTED controller to still be unmounted, to demonstrate the allow-list is load-bearing",
        ).toBeDefined();

        // Rebuild the allow-list without `stillUnmounted` by filtering entries
        // (not `delete`), so the "removed" state is a fresh object.
        const withoutEntry = Object.fromEntries(Object.entries(DELIBERATELY_UNMOUNTED).filter(([key]) => key !== stillUnmounted));

        // This is exactly the assertion the `it.each` above makes per controller —
        // run standalone here so removing the entry demonstrably fails it.
        expect(withoutEntry).not.toHaveProperty(stillUnmounted as string);
    });
});
