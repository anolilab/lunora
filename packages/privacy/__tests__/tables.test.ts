import { describe, expect, it } from "vitest";

import { REQUEST_STATUSES } from "../../../shared/privacy-request-status";
import privacyExtension from "../src/tables";

/** The Standard Schema surface every Lunora validator carries. */
interface StandardSchemaV1 {
    readonly "~standard": { readonly validate: (value: unknown) => Promise<{ readonly issues?: unknown }> | { readonly issues?: unknown } };
}

describe("privacyExtension", () => {
    it("is keyed privacy so every table is prefixed privacy_", () => {
        expect(privacyExtension.key).toBe("privacy");
    });

    it("declares the three tables the lifecycle and the archive need", () => {
        expect(Object.keys(privacyExtension.tables).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["archive", "events", "requests"]);
    });

    it("accepts every status the lifecycle can write to the requests table, and nothing else", async () => {
        const column = (privacyExtension.tables.requests as unknown as { shape: Record<string, StandardSchemaV1> }).shape.status;
        const accepts = async (value: string): Promise<boolean> => {
            const result = await column?.["~standard"].validate(value);

            return result?.issues === undefined;
        };

        await expect(Promise.all(REQUEST_STATUSES.map(async (status) => accepts(status)))).resolves.toStrictEqual(REQUEST_STATUSES.map(() => true));
        await expect(accepts("archived")).resolves.toBe(false);
    });
});
