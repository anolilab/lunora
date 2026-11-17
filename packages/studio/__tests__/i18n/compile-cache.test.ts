import { compileMessage } from "@lingui/message-utils/compileMessage";
import { describe, expect, it, vi } from "vitest";

import { createStudioI18n } from "../../src/i18n/i18n-context";

vi.mock(import("@lingui/message-utils/compileMessage"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, compileMessage: vi.fn<typeof original.compileMessage>(original.compileMessage) };
});

describe("studio i18n message compiler", () => {
    it("parses each source string once, however often and with whatever values it is rendered", () => {
        expect.assertions(3);

        const i18n = createStudioI18n();
        const rendered = ["a", "b", "c", "d"].map((name) => i18n._("Select {name}", { name }));

        expect(rendered).toStrictEqual(["Select a", "Select b", "Select c", "Select d"]);
        expect(vi.mocked(compileMessage).mock.calls.filter(([message]) => message === "Select {name}")).toHaveLength(1);

        // A second instance shares the cache: the compiled form depends on the string alone.
        expect(createStudioI18n()._("Select {name}", { name: "e" })).toBe("Select e");
    });
});
