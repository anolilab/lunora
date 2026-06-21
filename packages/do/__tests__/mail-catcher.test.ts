import { describe, expect, it } from "vitest";

import { clearCapturedMail, MAIL_RETENTION, MAIL_TABLE, MAX_BODY_CHARS, readCapturedMail, recordCapturedMail } from "../src/mail-catcher";
import createSqliteExec from "./_helpers/node-sqlite";

describe("mail-catcher module", () => {
    it("records a captured message and reads it back newest-first", () => {
        expect.assertions(5);

        const database = createSqliteExec();

        try {
            const first = recordCapturedMail(database.sql, { from: "noreply@x.test", subject: "Welcome", text: "hi", to: "a@x.test" }, 1000);
            recordCapturedMail(database.sql, { cc: ["c@x.test"], subject: "Reset", to: ["b@x.test"] }, 2000);

            const { entries } = readCapturedMail(database.sql);

            expect(entries).toHaveLength(2);
            // Newest first.
            expect(entries[0]?.subject).toBe("Reset");
            expect(entries[0]?.to).toStrictEqual(["b@x.test"]);
            expect(entries[0]?.cc).toStrictEqual(["c@x.test"]);
            expect(entries[1]?.id).toBe(first.id);
        } finally {
            database.close();
        }
    });

    it("round-trips headers and a string recipient", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            recordCapturedMail(database.sql, { headers: { "x-test": "1" }, html: "<b>hi</b>", subject: "S", to: "a@x.test" }, 10);

            const { entries } = readCapturedMail(database.sql);

            expect(entries[0]?.to).toBe("a@x.test");
            expect(entries[0]?.headers).toStrictEqual({ "x-test": "1" });
        } finally {
            database.close();
        }
    });

    it("trims the inbox to the retention cap", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            for (let index = 0; index < MAIL_RETENTION + 25; index += 1) {
                recordCapturedMail(database.sql, { subject: `S${String(index)}`, to: "a@x.test" }, index);
            }

            const count = database.raw(`SELECT COUNT(*) AS c FROM "${MAIL_TABLE}"`)[0] as { c: number };

            expect(count.c).toBe(MAIL_RETENTION);
        } finally {
            database.close();
        }
    });

    it("clears the inbox", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            recordCapturedMail(database.sql, { subject: "S", to: "a@x.test" }, 1);
            clearCapturedMail(database.sql);

            expect(readCapturedMail(database.sql).entries).toHaveLength(0);
        } finally {
            database.close();
        }
    });

    it("caps an oversized body so one giant email can't bloat the DO", () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const huge = "x".repeat(MAX_BODY_CHARS + 5000);
            recordCapturedMail(database.sql, { html: huge, subject: "Big", to: "a@x.test" }, 1);

            const stored = readCapturedMail(database.sql).entries[0]?.html ?? "";

            expect(stored.length).toBeLessThan(huge.length);
            expect(stored).toContain("truncated by the dev mail catcher");
        } finally {
            database.close();
        }
    });

    it("reads an empty inbox without throwing on a never-used app", () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            expect(readCapturedMail(database.sql).entries).toStrictEqual([]);
        } finally {
            database.close();
        }
    });
});
