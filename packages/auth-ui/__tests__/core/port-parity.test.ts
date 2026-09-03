import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { namedValueExportsOf } from "../../../client/__tests__/lib/named-exports";

/**
 * `core/index.ts` is the framework-agnostic barrel every port (React, Vue,
 * Svelte, Solid, Solid 2, Angular) is meant to build on: each `create*Controller`
 * factory it exports is a flow (sign-in, invitations, two-factor, …) that some
 * port is expected to mount. Nothing enforces that today — a controller can
 * ship, sit unconsumed by every port, and nobody notices until an audit
 * goes looking. Six such orphans shipped that way (see plan 233).
 *
 * This test reads the export list back out of `core/index.ts` itself — not a
 * hand-copied list, which would silently drift the moment a controller is
 * added or renamed — and fails on any `create*Controller` with zero
 * consumers across the port directories, unless it is named on
 * {@link DELIBERATELY_UNMOUNTED} with a reason. An unexplained allow-list
 * entry is exactly the silent hole this test exists to close, so every entry
 * must say why: either a still-open follow-up, or a structural reason the
 * export was never meant to be mounted directly (a builder primitive other
 * controllers call, not a flow a port renders).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_UI_SRC = resolve(HERE, "..", "..", "src");
const CORE_INDEX = join(AUTH_UI_SRC, "core", "index.ts");

const PORT_NAMES = ["react", "vue", "solid", "solid-v2", "svelte", "angular"] as const;

type PortName = (typeof PORT_NAMES)[number];

const PORT_DIRS: Record<PortName, string> = Object.fromEntries(PORT_NAMES.map((name) => [name, join(AUTH_UI_SRC, name)])) as Record<PortName, string>;

/**
 * Two ports keep their components in single-file components, not `.ts` — a
 * `.tsx?`-only walk sees Vue and Svelte as plumbing modules only and never
 * reads a card, so both would count as consuming nothing.
 */
/** Either way a port can reach the badge value. */
const BADGE_READER_RE = /readLastLoginMethod\(|lastLoginMethodStore/u;

const PORT_FILE_RE = /\.(?:svelte|tsx?|vue)$/;
const CONTROLLER_NAME_RE = /^create[A-Z]\w*Controller$/;

/**
 * Controllers with zero port consumers today, and why that's expected. Every
 * entry needs a reason — either it's a genuine open gap (cite the plan) or a
 * structural one (a factory other controllers call, never mounted itself).
 */
const DELIBERATELY_UNMOUNTED: Record<string, string> = {
    createActiveMemberController: "orphan — no port wires org active-member switching yet (plan 233 evidence); still unaddressed on this base",
    createFormController:
        "generic form-builder primitive, not a mountable flow — every domain controller that needs a form (backup-codes, sign-in, sign-up, …) calls it internally; a port mounts the domain controller, never this one directly",
    createPhoneForgotPasswordController: "orphan — no port wires phone-based password-reset request yet (plan 233 evidence); still unaddressed on this base",
    createPhoneResetPasswordController: "orphan — no port wires phone-based password reset yet (plan 233 evidence); still unaddressed on this base",
    createPhoneVerifyController: "orphan — no port wires phone verification yet (plan 233 evidence); still unaddressed on this base",
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

        return PORT_FILE_RE.test(entry.name) ? [full] : [];
    });

/**
 * Every `create*Controller` name `core/index.ts` exports as a VALUE (never a
 * type). Reads the barrel itself, via the shared `ts-morph`-based
 * {@link namedValueExportsOf}, so the list can't drift from what a port could
 * actually import — `export type { ... }` exports are excluded, and (unlike
 * a hand-rolled `export { ... }` block regex) a re-export via `export * from`
 * would still be picked up correctly.
 */
const controllerExports = (): string[] =>
    [...namedValueExportsOf(CORE_INDEX)].filter((name) => CONTROLLER_NAME_RE.test(name)).toSorted((a, b) => a.localeCompare(b));

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

        // This is the REAL predicate the `it.each` above evaluates per
        // controller — not "does `withoutEntry` still have the key" (true by
        // construction, since `filter` just removed it, and so unable to ever
        // fail regardless of whether the parity check itself works), but
        // whether the controller would actually pass the check without the
        // allow-list entry: it has no port consumer AND isn't on the reduced
        // allow-list. If that comes out `true`, removing the entry does NOT
        // fail the check — which is what "load-bearing" would have meant.
        const wouldStillPassWithoutEntry = consumersOf(stillUnmounted as string).length > 0 || Object.hasOwn(withoutEntry, stillUnmounted as string);

        expect(wouldStillPassWithoutEntry).toBe(false);
    });
});

/**
 * `core/last-login-method.ts` records `"email"` for a password sign-in and
 * `"magic-link"` for a magic link — not just OAuth provider ids — and its own
 * docblock warns that badging only the social buttons "makes the feature do
 * nothing for the most common case there is". Every port read the cookie and
 * then handed it to `SocialButtons` alone, so a deployment whose users sign in
 * with a password installed the plugin, paid for the cookie, and showed
 * nothing at all.
 *
 * Read from source rather than rendered per port on purpose: the whole point is
 * that a *new* port can be added and quietly skip the two non-social badges,
 * which is exactly what a per-port render test cannot notice.
 */
describe("last-used badge × port parity", () => {
    it.each(PORT_NAMES)("%s badges the password and magic-link methods, not just the social buttons", (port) => {
        expect.assertions(2);

        const sources = filesUnder(PORT_DIRS[port]).map((file) => readFileSync(file, "utf8"));
        // Assert the COMPARISON, not an occurrence count: a count is satisfied by
        // an unused import plus a mention in a comment, which is exactly the
        // shape a half-ported card would have.
        const comparedAgainst = (name: string): boolean =>
            sources.some((source) => new RegExp(String.raw`(?:===|!==)\s*${name}\b|\b${name}\s*(?:===|!==)`, "u").test(source));

        expect(comparedAgainst("LAST_METHOD_EMAIL"), `${port} never compares against LAST_METHOD_EMAIL, so a password sign-in shows no "last used" badge`).toBe(
            true,
        );
        expect(
            comparedAgainst("LAST_METHOD_MAGIC_LINK"),
            `${port} never compares against LAST_METHOD_MAGIC_LINK, so a magic-link sign-in shows no "last used" badge`,
        ).toBe(true);
    });
});

/**
 * The badge reads an unsigned, attacker-writable cookie that survives the plugin
 * being turned off, so every port must gate it on `plugins.lastLoginMethod`
 * rather than on the cookie's presence. `SocialButtons` was gated from the
 * start; the email and magic-link badges were not, in any port — the shape that
 * makes a stale cookie badge a method the deployment no longer offers.
 *
 * Asserted at the source, like the parity checks above, because the failure mode
 * is a NEW port copying the ungated read — which is exactly what a per-port
 * render test cannot see.
 */
describe("last-used badge × plugin gate", () => {
    it.each(PORT_NAMES)("%s gates its last-used badge on plugins.lastLoginMethod", (port) => {
        expect.assertions(1);

        // Per FILE, not per count: the ports read the cookie through different
        // primitives (`readLastLoginMethod` directly, or `lastLoginMethodStore`),
        // so a total-occurrence proxy drifts the moment one port changes shape.
        const ungated = filesUnder(PORT_DIRS[port])
            .map((file) => [file, readFileSync(file, "utf8")] as const)
            .filter(([, source]) => BADGE_READER_RE.test(source))
            .filter(([, source]) => !source.includes("plugins.lastLoginMethod"))
            .map(([file]) => file.slice(file.lastIndexOf("/") + 1));

        expect(
            ungated,
            `${port} shows the last-used badge without checking plugins.lastLoginMethod in: ${ungated.join(", ")} — a stale cookie then badges a method the deployment no longer offers`,
        ).toStrictEqual([]);
    });
});

/**
 * `?redirectTo=` is written by `invitations.ts` and by an app's own route guard,
 * and is only honoured where a completion path resolves it. Twelve sign-in doors
 * did; three did not, and the miss is invisible — the bounce looks like it
 * worked and quietly drops the user on the generic post-login page.
 *
 * A raw `nav.replace(context.redirects.afterSignIn)` is that bug's signature, so
 * assert there are none left outside an allow-list that must say why. There is
 * no single seam to fix instead: the doors reach three different sinks (a client
 * `nav.replace`, a `createFormController` submit result, and a wire
 * `callbackURL`), and `sign-in.ts` deliberately returns
 * `withRedirectTo(redirects.twoFactor)` on its 2FA branch, which a blanket
 * resolve would clobber. One spelling everywhere, enforced here.
 */
/** The raw navigation this gate forbids — hoisted so it compiles once. */
const RAW_AFTER_SIGN_IN_RE = /nav\.replace\(\s*context\.redirects\.afterSignIn\s*\)/u;

const RAW_AFTER_SIGN_IN_ALLOWED: Readonly<Record<string, string>> = {
    // This screen is the invitation itself — the thing `?redirectTo=` points at.
    // Resolving here would bounce an accepted invitation back to itself.
    "invitations.ts": "the redirect destination, not a door that bounces through sign-in",
};

describe("redirectTo × sign-in completion paths", () => {
    it("resolves redirectTo on every completion path that navigates after sign-in", () => {
        expect.assertions(1);

        const raw = filesUnder(join(AUTH_UI_SRC, "core"))
            .filter((file) => RAW_AFTER_SIGN_IN_RE.test(readFileSync(file, "utf8")))
            .map((file) => file.slice(file.lastIndexOf("/") + 1))
            .filter((name) => !Object.hasOwn(RAW_AFTER_SIGN_IN_ALLOWED, name));

        expect(raw, `these navigate to redirects.afterSignIn without resolving ?redirectTo=: ${raw.join(", ")}`).toStrictEqual([]);
    });
});

/**
 * The badge value comes from `document.cookie`, which the server does not have.
 * A read during render therefore emits markup the server could not have
 * produced — React 19 responds to a hydration mismatch by throwing away the
 * server tree and re-rendering the whole subtree on the client.
 *
 * So every port must read it AFTER mount. The post-mount primitive differs per
 * framework (`useSyncExternalStore` with a server snapshot, `onMounted`,
 * `onMount`, `afterNextRender`), which is why this asserts the property rather
 * than one spelling: the read may not sit at render/setup position.
 */
const POST_MOUNT_PRIMITIVE: Readonly<Record<PortName, RegExp>> = {
    angular: /afterNextRender\(/u,
    react: /useSyncExternalStore\(/u,
    solid: /onMount\(/u,
    // Solid 2 spells Solid 1.x's `onMount` as `onSettled`.
    "solid-v2": /onSettled\(/u,
    svelte: /onMount\(/u,
    vue: /onMounted\(/u,
};

describe("last-used badge × SSR safety", () => {
    it.each(PORT_NAMES)("%s reads the last-login cookie after mount, not during render", (port) => {
        expect.assertions(1);

        const readers = filesUnder(PORT_DIRS[port])
            .map((file) => [file, readFileSync(file, "utf8")] as const)
            .filter(([, source]) => BADGE_READER_RE.test(source));

        const unguarded = readers.filter(([, source]) => !POST_MOUNT_PRIMITIVE[port].test(source)).map(([file]) => file.slice(file.lastIndexOf("/") + 1));

        expect(unguarded, `${port} reads the last-login cookie during render in: ${unguarded.join(", ")} — that is a hydration mismatch`).toStrictEqual([]);
    });
});
