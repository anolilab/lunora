import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import isWellFormedCron from "../src/cron-grammar";
import isValidWithCronParser from "../src/validate-cron-full";

const parityExpressions = (JSON.parse(readFileSync(new URL("cron-parity.json", import.meta.url), "utf8")) as { cases: { expected: string }[] }).cases.map(
    (parityCase) => parityCase.expected,
);

const handWritten = [
    "* * * * *",
    "*/15 * * * *",
    "1-5/2 * * * *",
    "0-59/5 * * * *",
    "5/10 * * * *",
    "1,2,3 * * * *",
    "1-5,10 * * * *",
    "0 0 * * ?",
    "0 0 L * *",
    "0 0 5L * *",
    "0 9 * * MON-FRI",
    "0 9 * * mon,tue",
    "0 0 1 JAN *",
    "0 0 1 jan-mar *",
    "0 0 * * 5#2",
    "0 0 * * 5L",
    "0 0 * * 0",
    "0 0 * * 7",
    "* * * * * *",
    "30 */5 * * * *",
    "  0 0 * * *  ",
    "*\t*  * * *",
    "@hourly",
    "@daily",
    "@weekly",
    "@monthly",
    "@yearly",
    "@annually",
    "@reboot",
    "@HOURLY",
    "60 * * * *",
    "* 24 * * *",
    "* * 32 * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * 0 *",
    "* * * * 8",
    "* * * * * * *",
    "60 * * * * *",
    "*/0 * * * *",
    "5-1 * * * *",
    "1- * * * *",
    "a * * * *",
    "1.5 * * * *",
    "+1 * * * *",
    "1,,2 * * * *",
    "1/2/3 * * * *",
    "* * * * L",
    "L",
    "* * * * 1#6",
    "* * * * 8#1",
    "",
    "   ",
];

describe("isWellFormedCron", () => {
    it.each([...parityExpressions, ...handWritten])("agrees with cron-parser on %j", (expression) => {
        expect.assertions(1);
        expect(isWellFormedCron(expression)).toBe(isValidWithCronParser(expression));
    });

    it("rejects non-strings", () => {
        expect.assertions(1);
        expect(isWellFormedCron(undefined as unknown as string)).toBe(false);
    });
});
