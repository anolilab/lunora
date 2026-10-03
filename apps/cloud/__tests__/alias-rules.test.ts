import { isReleaseAlias, MAX_RELEASE_ALIAS_LENGTH } from "@lunora/config/celld";
import { HOSTD_PROTOCOL_LIMITS, isAlias } from "@lunora/hostd/protocol";
import { describe, expect, it } from "vitest";

/**
 * `lunora-hostd`'s wire protocol must stay dependency-free and run in workerd,
 * so it cannot import `@lunora/config` and keeps its own alias rule
 * (`apps/hostd/src/wire/validate.ts`). This app depends on both: it is where
 * the two are held to one answer — a box must never refuse an alias the
 * control plane deployed, nor accept one the control plane would refuse.
 */
describe("hostd's alias rule", () => {
    const longest = `a${"b".repeat(MAX_RELEASE_ALIAS_LENGTH - 2)}c`;
    const corpus = [
        // Accepted by both.
        "a",
        "0",
        "web",
        "web-pr-7",
        "a1-b2-c3",
        "123",
        longest,
        // Refused by both.
        "",
        "-web",
        "web-",
        "web--pr",
        "-",
        "Web",
        "WEB",
        "web_1",
        "web.pr",
        "web pr",
        " web",
        "web\n",
        "wéb",
        "web١",
        "ｗｅｂ",
        `${longest}d`,
        "a".repeat(200),
    ];

    it.each(corpus.map((alias) => [JSON.stringify(alias), alias]))("answers %s as @lunora/config/celld does", (_label, alias) => {
        expect.assertions(1);

        expect(isAlias(alias)).toBe(isReleaseAlias(alias));
    });

    it("caps an alias at the same length", () => {
        expect.assertions(3);

        expect(HOSTD_PROTOCOL_LIMITS.maxAliasLength).toBe(MAX_RELEASE_ALIAS_LENGTH);
        expect(isAlias(longest)).toBe(true);
        expect(isAlias(`${longest}d`)).toBe(false);
    });

    it("agrees on random strings near the rule's edges", () => {
        expect.hasAssertions();

        // A fixed-seed generator: a failure reproduces.
        let seed = 24_301;
        const next = (bound: number): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

            return seed % bound;
        };
        const alphabet = "abz09--A_. ";
        const disagreements: string[] = [];

        for (let sample = 0; sample < 5000; sample += 1) {
            const alias = Array.from({ length: next(MAX_RELEASE_ALIAS_LENGTH + 4) }, () => alphabet[next(alphabet.length)]).join("");

            if (isAlias(alias) !== isReleaseAlias(alias)) {
                disagreements.push(alias);
            }
        }

        expect(disagreements).toStrictEqual([]);
    });
});
