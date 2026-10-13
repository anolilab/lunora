/**
 * Compile-time only (included by `tsc --noEmit`): nested relation writes are typed by relation kind, and a
 * to-one's foreign key becomes optional on `insert` when the relation can supply it.
 */
import type { Id, InsertValues, RelationWrites } from "../src/data-model";

interface DataModel {
    posts: { _id: Id<"posts">; authorId: Id<"users">; title: string };
    users: { _id: Id<"users">; name: string };
}

interface InsertModel {
    posts: { authorId: Id<"users">; title: string };
    users: { name: string };
}

interface Relations {
    posts: { author: { __field: "authorId"; __relationKind: "one"; __target: "users" } };
    users: { posts: { __relationKind: "many"; __target: "posts" } };
}

type Rel = Relations;

const check = (): unknown[] => {
    const toOne: RelationWrites<DataModel, Rel, "posts"> = { author: { connect: "u" as Id<"users"> } };
    const toMany: RelationWrites<DataModel, Rel, "users"> = { posts: { connect: ["p" as Id<"posts">], set: [] } };

    const inserts: ReadonlyArray<InsertValues<DataModel, InsertModel, Rel, "posts">> = [
        // the key itself
        { authorId: "u" as Id<"users">, title: "t" },
        // or the relation that supplies it
        { author: { connect: "u" as Id<"users"> }, title: "t" },
        // @ts-expect-error -- a connect names the target table's id, not a plain string
        { author: { connect: "u" }, title: "t" },
        // @ts-expect-error -- not a relation of `posts`
        { editor: { connect: "u" as Id<"users"> }, title: "t" },
    ];

    const userInserts: ReadonlyArray<InsertValues<DataModel, InsertModel, Rel, "users">> = [
        { name: "ada", posts: { connect: ["p" as Id<"posts">] } },
        // @ts-expect-error -- a to-many takes a list, not a single id
        { name: "ada", posts: { connect: "p" as Id<"posts"> } },
    ];

    const patches: ReadonlyArray<Partial<InsertModel["posts"]> & RelationWrites<DataModel, Rel, "posts">> = [
        { title: "t" },
        { author: { disconnect: true } },
        // @ts-expect-error -- a to-one has no `set`
        { author: { set: [] } },
    ];

    return [toOne, toMany, inserts, userInserts, patches];
};

export default check;
