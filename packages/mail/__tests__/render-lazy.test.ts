import { describe, expect, it, vi } from "vitest";

import { createMailer } from "../src";

const loaded = vi.hoisted(() => {
    return { value: false };
});

// The factory runs only when the module is actually imported, so it records
// whether anything pulled the ~400 KiB renderer in.
vi.mock(import("@react-email/render"), async (importOriginal) => {
    loaded.value = true;

    return importOriginal();
});

describe("@react-email/render loading", () => {
    it("is not imported by a mailer that only sends pre-rendered HTML", async () => {
        expect.assertions(1);

        const mailer = createMailer({
            from: "noreply@x.test",
            transport: {
                send: async () => {
                    return { id: "1" };
                },
            },
        });

        await mailer.send({ html: "<p>hi</p>", subject: "Hi", to: "a@x.test" });

        expect(loaded.value).toBe(false);
    });
});
