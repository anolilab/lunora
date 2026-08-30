/* eslint-disable no-secrets/no-secrets -- false positive: `composePluginMiddleware` is a function name referenced in the docblock, not a credential. */

/**
 * Composed middleware must carry the policy tags it wrapped.
 *
 * `rls()` / `mask()` stamp their policy on the middleware FUNCTION object (a
 * non-enumerable, `Symbol.for`-keyed property), and the builder hoists them by
 * reading those tags off the DIRECT elements of the `.use(...)` chain. A
 * composer that folds N middlewares into one fresh arrow — `protectPublic`,
 * `composePluginMiddleware` — therefore dropped every tag it wrapped.
 *
 * The failure is silent and security-relevant: with no `fn.rls`, the table gets
 * no group in `buildRlsReadRegistry`, `resolveReadBaseWhere` answers
 * `undefined` ("unrestricted") for any table that is not `.rls("required")`, and
 * a `defineShape` over it replicates every row to every client — even though the
 * procedure the middleware was attached to still enforces the policy at request
 * time.
 */
import { describe, expect, it } from "vitest";

import type { Middleware } from "../src/index";
import {
    buildMaskRegistry,
    buildRlsReadRegistry,
    composePluginMiddleware,
    definePlugin,
    definePolicies,
    definePolicy,
    initLunora,
    mask,
    protectPublic,
    rls,
} from "../src/index";

const builders = initLunora.dataModel<unknown>().create();

/** Register a query behind `middleware` and hand back the registration the builder produced. */
const registerWith = (middleware: unknown): Record<string, unknown> =>
    (builders.query as unknown as { use: (m: unknown) => { query: (h: () => unknown) => Record<string, unknown> } }).use(middleware).query(() => null);

const readOwnDocs = definePolicy({
    on: "read",
    table: "docs",
    when: ({ auth }) => {
        return { ownerId: auth.userId };
    },
});

const readOwnNotes = definePolicy({
    on: "read",
    table: "notes",
    when: ({ auth }) => {
        return { ownerId: auth.userId };
    },
});

/** A no-op middleware standing in for a rate limit / captcha in the bundle. */
const passThrough: Middleware<unknown, unknown> = async ({ ctx, next }) => next({ ctx: ctx as Record<string, unknown> });

/** `rls()` / `mask()` are typed against a data model; erase that for these structural tests. */
const asMiddleware = (middleware: unknown): Middleware<unknown, unknown> => middleware as Middleware<unknown, unknown>;

describe("protectPublic carries the policy tags of its inner chain", () => {
    it("hoists an rls() nested in `use` onto fn.rls, so the table is not unrestricted", () => {
        expect.assertions(2);

        const fn = registerWith(
            protectPublic({
                rateLimit: passThrough,
                use: [asMiddleware(rls(definePolicies([readOwnDocs])))],
            }),
        );

        expect(fn["rls"]).toBeDefined();

        const registry = buildRlsReadRegistry([fn]);

        expect(registry.byTable.get("docs")).toHaveLength(1);
    });

    it("keeps each rls() step its own group rather than flattening them", () => {
        expect.assertions(2);

        const fn = registerWith(
            protectPublic({
                use: [asMiddleware(rls(definePolicies([readOwnDocs]))), asMiddleware(rls(definePolicies([readOwnNotes])))],
            }),
        );

        const registry = buildRlsReadRegistry([fn]);

        expect(registry.byTable.get("docs")).toHaveLength(1);
        expect(registry.byTable.get("notes")).toHaveLength(1);
    });

    it("hoists a mask() nested in `use` onto fn.maskedTables", () => {
        expect.assertions(1);

        const fn = registerWith(protectPublic({ use: [asMiddleware(mask({ users: { ssn: "redact" } }))] }));
        const registry = buildMaskRegistry([fn]);

        expect([...(registry.get("users") ?? [])]).toStrictEqual(["ssn"]);
    });
});

describe("composePluginMiddleware carries the policy tags of its inner chain", () => {
    it("hoists a plugin's rls() middleware onto fn.rls", () => {
        expect.assertions(2);

        const guarded = definePlugin("guarded", { middleware: asMiddleware(rls(definePolicies([readOwnDocs]))) });
        const fn = registerWith(composePluginMiddleware([guarded]));

        expect(fn["rls"]).toBeDefined();

        const registry = buildRlsReadRegistry([fn]);

        expect(registry.byTable.get("docs")).toHaveLength(1);
    });

    it("unions the masked columns of every plugin it composes", () => {
        expect.assertions(2);

        const redactSsn = definePlugin("redact-ssn", { middleware: asMiddleware(mask({ users: { ssn: "redact" } })) });
        const hashPhone = definePlugin("hash-phone", { middleware: asMiddleware(mask({ users: { phone: "hash" } })) });
        const fn = registerWith(composePluginMiddleware([redactSsn, hashPhone]));
        const registry = buildMaskRegistry([fn]);

        expect([...(registry.get("users") ?? [])].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["phone", "ssn"]);
        expect(fn["maskedTables"]).toBeDefined();
    });

    it("leaves a tag-free composition untagged, so a non-policy function carries no rls key", () => {
        expect.assertions(2);

        const plain = definePlugin("plain", { middleware: passThrough });
        const fn = registerWith(composePluginMiddleware([plain]));

        expect(fn).not.toHaveProperty("rls");
        expect(fn).not.toHaveProperty("maskedTables");
    });
});
