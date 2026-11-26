/**
 * Compile-time only (included by `tsc --noEmit`): an optional column reads back absent, so `null` is how `where` asks
 * for "not set". The row has the shape codegen emits for `v.optional(v.number())` on a `.global()` table.
 */
import type { Id, Where, WhereOf } from "../src/data-model";

interface ChatFile {
    _id: Id<"chatFiles">;
    discardingAt?: number;
    storageId: string;
}

interface DataModel {
    chatFiles: ChatFile;
}

const check = (): unknown[] => {
    const where: ReadonlyArray<Where<ChatFile>> = [
        { discardingAt: null, storageId: "s" },
        { discardingAt: 5 },
        { discardingAt: { eq: null } },
        { discardingAt: { in: [null, 5] } },
        { discardingAt: { isNull: false } },
        // @ts-expect-error -- a required column is never NULL
        { storageId: null },
        // @ts-expect-error -- the value must still match the column's type
        { discardingAt: "soon" },
    ];

    const whereOf: ReadonlyArray<WhereOf<DataModel, { chatFiles: object }, "chatFiles">> = [
        { discardingAt: null, storageId: "s" },
        { NOT: { discardingAt: null } },
        // @ts-expect-error -- a required column is never NULL
        { storageId: null },
    ];

    return [where, whereOf];
};

export default check;
