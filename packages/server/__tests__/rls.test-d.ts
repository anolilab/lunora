import type { EmptyArgs, MutationBuilder, QueryBuilder } from "../src/index";
import { definePolicies, definePolicy, protectPublic, rls } from "../src/index";

/**
 * Type-level proof that `.use(rls(...))` attaches to a procedure whose `ctx.db`
 * is a typed facade, the shape codegen emits, which is not assignable to the
 * runtime writer `rls()` wraps, and that the handler keeps that typed context.
 * Both lines failed to compile while `rls()` returned
 * `Middleware<RlsContextIn, RlsContextIn>`.
 */

interface Note {
    ownerId: string;
    text: string;
}

interface TypedDatabase {
    query: (table: "notes") => { take: (limit: number) => Promise<Note[]> };
}

interface GeneratedContext {
    auth: { userId: null | string };
    db: TypedDatabase;
}

const expectNotes = (_value: Note[]): void => undefined;

const check = (): void => {
    const query = null as unknown as QueryBuilder<GeneratedContext, EmptyArgs>;
    const mutation = null as unknown as MutationBuilder<GeneratedContext, EmptyArgs>;
    const policies = definePolicies([definePolicy({ on: "read", table: "notes", when: ({ auth }) => (auth.userId ? { ownerId: auth.userId } : false) })]);

    query.use(rls(policies)).query(async ({ ctx }) => {
        expectNotes(await ctx.db.query("notes").take(1));

        // @ts-expect-error -- the typed facade survives the middleware: an unknown table is still rejected
        expectNotes(await ctx.db.query("other").take(1));
    });

    // Composed inside another middleware, where nothing pins the context up front.
    query.use(protectPublic({ use: [rls(policies)] })).query(async ({ ctx }) => {
        expectNotes(await ctx.db.query("notes").take(1));
    });

    // Two steps compose, and a mutation context is accepted the same way.
    mutation
        .use(rls(policies))
        .use(rls(policies))
        .mutation(async ({ ctx }) => {
            expectNotes(await ctx.db.query("notes").take(1));
        });
};

export default check;
