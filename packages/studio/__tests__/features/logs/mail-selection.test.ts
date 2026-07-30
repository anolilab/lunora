import { describe, expect, it } from "vitest";

import { matchingMail, recipientText, selectedLink, selectedMail } from "../../../src/features/logs/mail-selection";
import type { CapturedMail } from "../../../src/lib/admin";

const mail = (overrides: Partial<CapturedMail> & Pick<CapturedMail, "id">): CapturedMail =>
    ({ at: 0, from: "noreply@example.com", subject: "", to: "ada@example.com", ...overrides }) as CapturedMail;

describe("recipientText", () => {
    it("joins a list and passes a single recipient through", () => {
        expect.assertions(3);

        expect(recipientText("ada@example.com")).toBe("ada@example.com");
        expect(recipientText(["ada@example.com", "bob@example.com"])).toBe("ada@example.com, bob@example.com");
        expect(recipientText(undefined)).toBe("");
    });
});

describe("selectedLink", () => {
    it("prefers the HTML body over the plain-text one", () => {
        expect.assertions(1);

        // Both bodies usually carry the same link, but the HTML one is what the
        // recipient would actually click.
        expect(selectedLink(mail({ html: '<a href="https://app.test/verify?t=1">go</a>', id: "m1", text: "https://app.test/plain" }))).toBe(
            "https://app.test/verify?t=1",
        );
    });

    it("falls back to the text body, then to nothing", () => {
        expect.assertions(3);

        expect(selectedLink(mail({ id: "m1", text: "open https://app.test/reset now" }))).toBe("https://app.test/reset");
        expect(selectedLink(mail({ id: "m1", text: "no link here" }))).toBeUndefined();
        expect(selectedLink(undefined)).toBeUndefined();
    });

    it("stops the URL at quotes, brackets, and whitespace", () => {
        expect.assertions(3);

        // A magic link lifted out of markup must not drag the closing quote or tag
        // along, or pasting it into a browser 404s.
        expect(selectedLink(mail({ html: '<a href="https://app.test/a?b=1">x</a>', id: "m1" }))).toBe("https://app.test/a?b=1");
        expect(selectedLink(mail({ id: "m1", text: "see <https://app.test/b> please" }))).toBe("https://app.test/b");
        expect(selectedLink(mail({ id: "m1", text: "(https://app.test/c)" }))).toBe("https://app.test/c");
    });
});

describe("matchingMail", () => {
    // Hoisted so the multi-recipient case doesn't put a quoted address list on the
    // same line as the word "password", which the secret scanner reads as a generic
    // credential assignment.
    const resetRecipients = ["bob@example.com", "carol@example.com"];
    const entries = [
        mail({ id: "m1", subject: "Verify your email", to: "ada@example.com" }),
        mail({ id: "m2", subject: "Reset password", to: resetRecipients }),
    ];

    it("returns everything for a blank or whitespace filter", () => {
        expect.assertions(2);

        expect(matchingMail(entries, "")).toStrictEqual(entries);
        expect(matchingMail(entries, "   ")).toStrictEqual(entries);
    });

    it("matches subject and recipients case-insensitively", () => {
        expect.assertions(3);

        expect(matchingMail(entries, "VERIFY").map((entry) => entry.id)).toStrictEqual(["m1"]);
        expect(matchingMail(entries, "carol").map((entry) => entry.id)).toStrictEqual(["m2"]);
        expect(matchingMail(entries, "nobody")).toStrictEqual([]);
    });
});

describe("selectedMail", () => {
    const entries = [mail({ id: "m1" }), mail({ id: "m2" })];

    it("keeps the selection when it is still visible", () => {
        expect.assertions(1);

        expect(selectedMail(entries, "m2")?.id).toBe("m2");
    });

    it("defaults to the newest visible message", () => {
        expect.assertions(3);

        // The list is newest-first, so falling back to index 0 is what stops a
        // refresh or a filter change from leaving the detail pane blank.
        expect(selectedMail(entries, null)?.id).toBe("m1");
        expect(selectedMail(entries, "gone")?.id).toBe("m1");
        expect(selectedMail([], "m1")).toBeUndefined();
    });
});
