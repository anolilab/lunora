import type { EmptyArgs, QueryBuilder } from "../src/index";
import { mask } from "../src/index";

/**
 * Type-level proof that `.use(mask(...))` attaches to a procedure whose `ctx.db`
 * is a typed facade (the shape codegen emits) and that the handler keeps it.
 */

interface Note {
    text: string;
}

interface GeneratedContext {
    auth: { userId: null | string };
    db: { query: (table: "notes") => { take: (limit: number) => Promise<Note[]> } };
}

const expectNotes = (_value: Note[]): void => undefined;

const check = (): void => {
    const query = null as unknown as QueryBuilder<GeneratedContext, EmptyArgs>;

    query.use(mask({ notes: { text: () => "***" } })).query(async ({ ctx }) => {
        expectNotes(await ctx.db.query("notes").take(1));
    });
};

export default check;
