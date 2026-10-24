import { describe, expect, it } from "vitest";

import { applyOnDelete } from "../src/relations";

describe("applyOnDelete holder reads", () => {
    it("reads each holder once: the ceiling probe's ids are cascaded, not read again", async () => {
        expect.assertions(2);

        const holders = new Set(Array.from({ length: 1200 }, (_, index) => `m${String(index)}`));
        let rowsRead = 0;

        await applyOnDelete({
            deletedId: "u1",
            deletedReference: () => undefined,
            findHolders: async (_table, _field, _value, page) => {
                const rows = [...holders].slice(0, page.limit).map((id) => {
                    return { _id: id };
                });

                rowsRead += rows.length;

                return rows;
            },
            onCascade: async (_table, id) => {
                holders.delete(id);
            },
            onRestrict: (message) => {
                throw new Error(message);
            },
            onSetNull: async () => {},
            schema: {
                tables: {
                    messages: {
                        indexes: [],
                        relationMap: { author: { field: "authorId", kind: "one", onDelete: "cascade", references: "_id", table: "users" } },
                        shape: {},
                    },
                    users: { indexes: [], shape: {} },
                },
            },
            tableName: "users",
        });

        expect(holders.size).toBe(0);
        // The probe read all 1200; the one re-read that confirms nothing is left reads none.
        expect(rowsRead).toBe(1200);
    });

    it("probes a single holder for a restrict relation instead of the full ceiling", async () => {
        expect.assertions(2);

        const limits: number[] = [];

        await expect(
            applyOnDelete({
                deletedId: "u1",
                deletedReference: () => undefined,
                findHolders: async (_table, _field, _value, page) => {
                    limits.push(page.limit);

                    return [{ _id: "m0" }];
                },
                onCascade: async () => {},
                onRestrict: (message) => {
                    throw new Error(message);
                },
                onSetNull: async () => {},
                schema: {
                    tables: {
                        messages: {
                            indexes: [],
                            relationMap: { author: { field: "authorId", kind: "one", onDelete: "restrict", references: "_id", table: "users" } },
                            shape: {},
                        },
                        users: { indexes: [], shape: {} },
                    },
                },
                tableName: "users",
            }),
        ).rejects.toThrow("still references it");
        expect(limits).toStrictEqual([1]);
    });
});
