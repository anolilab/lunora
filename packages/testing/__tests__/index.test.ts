import { describe, expect, it } from "vitest";

import { extractLink, listCapturedMail, waitForMail } from "../src/index";

describe("@lunora/testing exports", () => {
    it("re-exports the mail-catcher testing helpers", () => {
        expect.assertions(3);

        expect(typeof extractLink).toBe("function");
        expect(typeof listCapturedMail).toBe("function");
        expect(typeof waitForMail).toBe("function");
    });
});
