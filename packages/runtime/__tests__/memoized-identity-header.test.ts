import { describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader, encodeIdentityHeaderJson } from "../../../shared/identity-header";
import { memoizedIdentityHeader } from "../src/memoize-identity";

vi.mock(import("../../../shared/identity-header"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, encodeIdentityHeaderJson: vi.fn<typeof actual.encodeIdentityHeaderJson>(actual.encodeIdentityHeaderJson) };
});

describe("memoizedIdentityHeader", () => {
    it("encodes repeated claims once", () => {
        expect.assertions(2);

        const claims = { subject: "memo-small", userId: "u1" };

        vi.mocked(encodeIdentityHeaderJson).mockClear();

        const first = memoizedIdentityHeader(claims);

        expect(memoizedIdentityHeader({ ...claims })).toBe(first);
        expect(encodeIdentityHeaderJson).toHaveBeenCalledTimes(1);
    });

    it("encodes oversized claims every time instead of remembering them", () => {
        expect.assertions(2);

        const claims = { note: "n".repeat(4096), subject: "memo-large" };

        vi.mocked(encodeIdentityHeaderJson).mockClear();
        memoizedIdentityHeader(claims);

        expect(decodeIdentityHeader(memoizedIdentityHeader({ ...claims }))).toStrictEqual(claims);
        expect(encodeIdentityHeaderJson).toHaveBeenCalledTimes(2);
    });
});
