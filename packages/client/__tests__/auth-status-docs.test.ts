/**
 * `@lunora/client/auth` defines the four-state auth gate every UI adapter
 * implements, and the docs restate it in prose. A restated contract drifts:
 * five pages shipped `useAuth` examples gating on `if (!user)`, which renders a
 * sign-in form to a signed-in user whenever a credential is held but its
 * identity has not resolved yet — an offline reload, or the window while a
 * cookie session resolves. `user === null` does not mean "signed out"; that is
 * what `status` is for, and only `status` can say it.
 *
 * So the contract is asserted rather than restated, the way
 * `@lunora/advisor`'s `docs-lint-reference.test.ts` pins its lint table:
 * {@link AUTH_STATUSES} is the source of truth for both reference tables, and
 * no page that demonstrates an adapter's auth primitive may gate on `user`.
 *
 * It lives here because this package owns the contract — a new state, or a
 * change to what one means, fails in the same diff. The consumer pages it
 * scans belong to other packages, so a docs-only edit THERE reaches this file
 * through a full `pnpm run test` rather than through `test:affected`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUTH_STATUSES } from "../src/auth";

const repoFile = (...segments: string[]): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ...segments), "utf8");

const docsPage = repoFile("docs", "index.mdx");
const authModule = repoFile("src", "auth", "index.ts");

/**
 * Every page that shows a reader how to consume an adapter's auth primitive.
 * Each must branch on `status`; a `user`-only gate is the bug this pins.
 */
const consumerPages = [
    ["@lunora/react", repoFile("..", "react", "docs", "index.mdx")],
    ["@lunora/solid", repoFile("..", "solid", "docs", "index.mdx")],
    ["@lunora/svelte", repoFile("..", "svelte", "docs", "index.mdx")],
    ["@lunora/vue", repoFile("..", "vue", "docs", "index.mdx")],
    ["@lunora/angular", repoFile("..", "angular", "docs", "index.mdx")],
    ["docs: concepts/authentication", repoFile("..", "..", "apps", "docs", "src", "content", "docs", "concepts", "authentication.mdx")],
    ["docs: frameworks/react", repoFile("..", "..", "apps", "docs", "src", "content", "docs", "frameworks", "react.mdx")],
    ["@lunora/client", docsPage],
] as const;

/**
 * Gating an auth branch on the user rather than the status. Covers the shapes
 * the pages actually used (`if (!user)`, `user === null`, `user == null`) plus
 * the framework spellings of the same test (`{#if $user}`, `v-if="!user"`).
 */
const USER_GATE = /if \(!\s*user\b|user\s*===?\s*null|\{#if \$?!?user\}|v-if="!?\s*user"|\{user \?/u;

/** First cell of every backticked-key markdown table row in `source`. */
const tableKeys = (source: string): Set<string> => new Set([...source.matchAll(/^\| `([a-z]+)` +\|/gmu)].map((match) => match[1] as string));

/** The "Auth status" section of the docs page — so no other table contributes rows. */
const authStatusSection = (): string => {
    const start = docsPage.indexOf("### Auth status");

    if (start === -1) {
        throw new Error('packages/client/docs/index.mdx has no "### Auth status" section');
    }

    const next = docsPage.indexOf("\n## ", start);

    return next === -1 ? docsPage.slice(start) : docsPage.slice(start, next);
};

describe("auth status documentation", () => {
    it("documents every status in the client docs reference table", () => {
        expect.assertions(1);

        expect(tableKeys(authStatusSection())).toStrictEqual(new Set(AUTH_STATUSES));
    });

    it("documents every status in the module's own contract table", () => {
        expect.assertions(1);

        // The header table's rows are ` * | `status` | meaning | gate |`.
        const documented = new Set([...authModule.matchAll(/^ \* \| `([a-z]+)` +\|/gmu)].map((match) => match[1] as string));

        expect(documented).toStrictEqual(new Set(AUTH_STATUSES));
    });

    it.each(consumerPages)("%s gates on status, never on user", (_name, page) => {
        expect.assertions(1);

        expect(page).not.toMatch(USER_GATE);
    });
});
