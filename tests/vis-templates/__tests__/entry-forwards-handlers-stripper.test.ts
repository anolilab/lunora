/**
 * The comment stripper behind `scripts/assert-entry-forwards-handlers.mjs`.
 *
 * That gate decides whether an app declares a cron, queue or inbound-email
 * handler by matching the builder call in the scaffold's source. Everything
 * rests on stripping comments without stripping code: a declaration it cannot
 * see is an app it believes declares nothing, so it exits 0 having checked
 * nothing — the exact vacuous pass the gate was rewritten to remove.
 *
 * The order of the three passes has been wrong twice:
 *
 * 1. Line comments first cut every line at its first `//`, which is not a
 *    comment inside `"https://…"`, so a declaration sharing a line with a URL
 *    disappeared.
 * 2. Block comments first let a `"/*"` in a string open a comment that ran
 *    through the next closing delimiter in a later string, swallowing every
 *    declaration between them.
 *
 * Blanking quoted strings first removes both openings. These cases pin that
 * order, in both directions: real comments must still hide a name, and code
 * must still be visible.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/no-relative-parent-imports -- the gate is a repo script, not a package export
import { reExportsDefault, stripToCode } from "../../../scripts/assert-entry-forwards-handlers.mjs";

/** What the gate itself asks of the stripped source. */
const declaresCron = (source: string): boolean => /\bcronJobs\s*\(/u.test(stripToCode(source));

describe("assert-entry-forwards-handlers — comment stripper", () => {
    it("keeps a declaration sharing its line with a URL", () => {
        expect.assertions(1);

        // `//` inside a string is not a comment. Cutting the line here left the
        // gate seeing no crons at all.
        expect(declaresCron(`const docs = "https://lunora.dev/crons";\nconst crons = cronJobs();`)).toBe(true);
    });

    it("keeps a declaration between two strings that look like comment delimiters", () => {
        expect.assertions(1);

        // Stripping block comments before strings let the first literal open a
        // comment that closed in the third, taking the declaration with it.
        expect(declaresCron(`const open = "/*";\nconst crons = cronJobs();\nconst close = "*/";`)).toBe(true);
    });

    it("still hides a name that appears only in a block comment", () => {
        expect.assertions(1);

        expect(declaresCron(`/* this app does not call cronJobs() */\nexport default app;`)).toBe(false);
    });

    it("still hides a name that appears only in a line comment", () => {
        expect.assertions(1);

        expect(declaresCron(`// forwards cronJobs() when one exists\nexport default app;`)).toBe(false);
    });

    it("sees a plain declaration", () => {
        expect.assertions(1);

        expect(declaresCron(`const crons = cronJobs();`)).toBe(true);
    });

    it("does not blank a template literal, which can hold real code", () => {
        expect.assertions(1);

        expect(declaresCron("const emit = `${cronJobs()}`;")).toBe(true);
    });
});

/**
 * The gate feeds STRIPPED source to the re-export check, and `stripToCode` blanks
 * every quoted string — so `from "./worker"` arrives as `from ""`. Asserting on
 * raw source passed while the real path matched nothing, so these go through the
 * same pipeline the gate does.
 */
const reExportsDefaultAsGateSeesIt = (source: string): boolean => reExportsDefault(stripToCode(source));

describe("assert-entry-forwards-handlers — opaque default re-exports", () => {
    // The exported NAME is what wrangler loads, so every spelling that produces a
    // `default` hands over a module this gate cannot read. Matching only the bare
    // form let the other three through: an entry declaring a cron and forwarding
    // nothing would have passed.
    it.each([
        ["bare", 'export { default } from "./worker";'],
        ["aliased to itself", 'export { default as default } from "./worker";'],
        ["a named binding aliased to default", 'export { worker as default } from "./worker";'],
        ["default alongside a named binding", 'export { default, ShardDO } from "./worker";'],
    ])("treats %s as an opaque default", (_label, source) => {
        expect.assertions(1);

        expect(reExportsDefaultAsGateSeesIt(source)).toBe(true);
    });

    it.each([
        // A star re-export does not carry the default binding, so there is no
        // opaque default to refuse.
        ["a star re-export", 'export * from "./worker";'],
        ["a named-only re-export", 'export { ShardDO } from "./worker";'],
        ["a locally defined default", "const app = {};\nexport default app;"],
    ])("does not flag %s", (_label, source) => {
        expect.assertions(1);

        expect(reExportsDefaultAsGateSeesIt(source)).toBe(false);
    });
});
