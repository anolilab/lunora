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

    it("cascades a holder a trigger inserts while a short probe is being cascaded", async () => {
        expect.assertions(1);

        // Fewer than one page: a probe this short used to end the walk before anything re-read the holders.
        const holders = new Set(["m0", "m1", "m2"]);

        await applyOnDelete({
            deletedId: "u1",
            deletedReference: () => undefined,
            findHolders: async (_table, _field, _value, page) =>
                [...holders].slice(0, page.limit).map((id) => {
                    return { _id: id };
                }),
            onCascade: async (_table, id) => {
                holders.delete(id);

                // A delete trigger on m0 inserts a new holder of the same parent.
                if (id === "m0") {
                    holders.add("m3");
                }
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

        expect([...holders]).toStrictEqual([]);
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

    describe("a refused parent delete", () => {
        const schemaWith = (second: "cascade" | "restrict") => {
            return {
                // The eligible relation's table is declared first, so a cascade that is not refused up front would run it.
                tables: {
                    messages: {
                        indexes: [],
                        relationMap: { author: { field: "authorId", kind: "one" as const, onDelete: "cascade" as const, references: "_id", table: "users" } },
                        shape: {},
                    },
                    comments: {
                        indexes: [],
                        relationMap: { post: { field: "postId", kind: "one" as const, onDelete: second, references: "_id", table: "users" } },
                        shape: {},
                    },
                    users: { indexes: [], shape: {} },
                },
            };
        };

        const holdersOf = (count: number) => new Set(Array.from({ length: count }, (_, index) => `h${String(index)}`));

        const reader = (pools: Record<string, Set<string>>) => {
            return {
                findHolders: async (table: string, _field: string, _value: unknown, page: { limit: number }) =>
                    [...(pools[table] ?? [])].slice(0, page.limit).map((id) => {
                        return { _id: id };
                    }),
                onCascade: async (table: string, id: string) => {
                    pools[table]?.delete(id);
                },
            };
        };

        it("refuses before cascading an earlier relation when a later one is over the ceiling", async () => {
            expect.assertions(2);

            const pools = { comments: holdersOf(10_001), messages: holdersOf(3) };

            await expect(
                applyOnDelete({
                    deletedId: "u1",
                    deletedReference: () => undefined,
                    ...reader(pools),
                    onRestrict: (message) => {
                        throw new Error(message);
                    },
                    onSetNull: async () => {},
                    schema: schemaWith("cascade"),
                    tableName: "users",
                }),
            ).rejects.toMatchObject({ code: "CASCADE_LIMIT" });
            expect(pools.messages.size).toBe(3);
        });

        it("refuses before cascading an earlier relation when a later one is restricted", async () => {
            expect.assertions(2);

            const pools = { comments: holdersOf(1), messages: holdersOf(3) };

            await expect(
                applyOnDelete({
                    deletedId: "u1",
                    deletedReference: () => undefined,
                    ...reader(pools),
                    onRestrict: (message) => {
                        throw new Error(message);
                    },
                    onSetNull: async () => {},
                    schema: schemaWith("restrict"),
                    tableName: "users",
                }),
            ).rejects.toThrow("still references it");
            expect(pools.messages.size).toBe(3);
        });
    });
});
