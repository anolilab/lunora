/**
 * The gate that catches a NEWLY ADDED admin route which forgets its gate.
 *
 * Every other admin test drives one path it names by hand, so a route added
 * tomorrow with no `assertAdmin` is caught by nothing: the suite stays green
 * because nothing walks the assembled route table. This walks it.
 *
 * The path list is DERIVED from the source rather than written here — a
 * hand-maintained copy would go stale in exactly the case the test exists for.
 * Every `/_lunora/admin/*` route path declared in `packages/runtime/src`, plain
 * literal or `${BASE}/suffix` template, is driven through `createWorker().fetch`
 * with no credential, and none of them may ANSWER: every response must be a 4xx.
 * The exact code is deliberately not pinned — a route refuses the verb (405), the
 * missing upgrade header (426) or the credential (403) depending on the order its
 * own preconditions run in, and a prefix constant that is not a route at all is a
 * 404. Pinning 403 would make the test a transcript of today's ordering; "no
 * unauthenticated caller is ever served" is the property that actually matters.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const SOURCE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

/**
 * Every `/_lunora/admin/...` route path the runtime declares, deduplicated.
 *
 * Two spellings occur: a plain literal (`"/_lunora/admin/kv/value"`) and a
 * template over a base constant (`` `${AUTH_BASE}/users` ``). Both are collected;
 * a base that is only ever a prefix stays in the list, because a 404 is a refusal
 * too and dropping it would need a rule that also drops real nested routes
 * (`/_lunora/admin/scheduled` and `/_lunora/admin/scheduled/dead` are both real).
 */
const adminPaths = (): string[] => {
    const found = new Set<string>();

    for (const entry of readdirSync(SOURCE_DIRECTORY)) {
        if (!entry.endsWith(".ts")) {
            continue;
        }

        const source = readFileSync(path.join(SOURCE_DIRECTORY, entry), "utf8");
        const bases = new Map<string, string>();

        for (const match of source.matchAll(/const ([A-Z_\d]+)\s*(?::\s*string\s*)?=\s*"(\/_lunora\/admin\/[a-z\d/_-]*)"/g)) {
            bases.set(match[1] as string, match[2] as string);
        }

        for (const match of source.matchAll(/"(\/_lunora\/admin\/[a-z\d/_-]*)"/g)) {
            found.add(match[1] as string);
        }

        for (const match of source.matchAll(/`\$\{([A-Z_\d]+)\}(\/[a-z\d/_-]*)`/g)) {
            const base = bases.get(match[1] as string);

            if (base !== undefined) {
                found.add(`${base}${match[2] as string}`);
            }
        }
    }

    // Every candidate is walked, prefix constants included — an unmounted prefix
    // answers 404, which is itself a refusal.
    // By UTF-16 code unit, the repo's ordering convention — `localeCompare` is not
    // stable across machines (`shared/rest-surface.ts` spells out why).
    return [...found].toSorted((a, b) => (a < b ? -1 : Number(a > b)));
};

/** The three request shapes an admin route can distinguish before it authorizes. */
const SHAPES: { headers: Record<string, string>; label: string; method: string }[] = [
    { headers: {}, label: "GET", method: "GET" },
    { headers: { "content-type": "application/json" }, label: "POST", method: "POST" },
    // The WS admin route checks the upgrade header before authorizing (426), so a
    // plain GET never reaches its gate.
    { headers: { Upgrade: "websocket" }, label: "GET(ws)", method: "GET" },
];

/**
 * Drive every declared admin path through a credential-less worker.
 * @returns `answered` — the (path, shape) pairs that returned anything below 400 — and `forbidden`, the paths that reached an admin gate.
 */
const walkAdminPaths = async (): Promise<{ answered: string[]; forbidden: Set<string> }> => {
    // No `adminToken`, no `adminGate`: `requestIsAdmin` fails closed with no token
    // configured, so EVERY admin path must refuse before it reads a body, resolves
    // an option, or touches a shard.
    const worker = createWorker({ shardDO: noopNamespace });
    const answered: string[] = [];
    const forbidden = new Set<string>();

    for (const pathname of adminPaths()) {
        for (const shape of SHAPES) {
            const request = new Request(`https://app.example${pathname}`, {
                ...(shape.method === "POST" ? { body: "{}" } : {}),
                headers: shape.headers,
                method: shape.method,
            });

            // eslint-disable-next-line no-await-in-loop -- a sequential walk of the route table; concurrency would only obscure which path failed
            const response = await worker.fetch(request, {}, fakeContext);

            if (response.status < 400) {
                answered.push(`${shape.label} ${pathname} → ${String(response.status)}`);
            }

            if (response.status === 403) {
                forbidden.add(pathname);
            }
        }
    }

    return { answered, forbidden };
};

describe("admin route table — every declared admin path is default-closed", () => {
    it("finds the admin paths to walk (anti-vacuity: the scan must not come back empty)", () => {
        expect.assertions(3);

        const paths = adminPaths();

        expect(paths.length).toBeGreaterThan(20);
        expect(paths).toContain("/_lunora/admin/functions");
        // The template-resolved half really resolved.
        expect(paths).toContain("/_lunora/admin/auth/sessions");
    });

    it("refuses every one of them with no credential", async () => {
        expect.assertions(2);

        // No `adminToken`, no `adminGate`: `requestIsAdmin` fails closed with no
        // token configured, so EVERY admin path must refuse before it reads a
        // body, resolves an option, or touches a shard.
        const { answered, forbidden } = await walkAdminPaths();

        expect(answered).toEqual([]);
        // Anti-vacuity: a scan that produced only unmounted prefixes would pass the
        // assertion above having tested nothing. Most of the table must actually
        // reach an admin gate and answer 403.
        expect(forbidden.size).toBeGreaterThan(adminPaths().length / 2);
    });
});
