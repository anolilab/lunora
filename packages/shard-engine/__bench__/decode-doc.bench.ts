import { bench, describe } from "vitest";

import { decodeDocJson, encodeDocJson } from "../src/do-sql";

/**
 * `decodeDocJson` runs once per row on every read: `ctx.db.get`, every row of a
 * `collect()`, a subscription re-run. Almost no stored document carries a
 * wire-tagged leaf, so this measures the plain-JSON row that dominates.
 */
const document = (index: number): Record<string, unknown> => {
    return {
        authorId: `user_${String(index % 50)}`,
        body: `message body number ${String(index)} — ${"lorem ipsum dolor sit amet ".repeat(4)}`,
        channelId: "channels:general",
        editedAt: index,
        meta: { flags: ["a", "b"], reactions: { heart: 3, thumbs: 1 } },
    };
};

const plainRows = Array.from({ length: 200 }, (_, index) => encodeDocJson(document(index)));
const taggedRows = Array.from({ length: 200 }, (_, index) => encodeDocJson({ ...document(index), at: new Date(index) }));

describe("decodeDocJson — 200 rows", () => {
    bench("plain JSON rows", () => {
        for (const raw of plainRows) {
            decodeDocJson(raw);
        }
    });

    bench("rows with a wire-tagged leaf", () => {
        for (const raw of taggedRows) {
            decodeDocJson(raw);
        }
    });
});
