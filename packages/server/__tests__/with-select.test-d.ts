import type { DatabaseReaderFacade } from "../src/data-model";

/**
 * Type-level proof that a per-relation `select` on a `with` load narrows the
 * loaded child to the selected columns (+ system fields) — for both a `one`
 * and a `many` relation. The `@ts-expect-error` lines fail compilation if the
 * narrowing regresses (a non-selected field would otherwise stay accessible).
 */
interface DM {
    posts: { _creationTime: number; _id: string; authorId: string; body: string; title: string };
    users: { _creationTime: number; _id: string; email: string; name: string };
}
type REL = {
    posts: { author: { __relationKind: "one"; __target: "users" } };
    users: { posts: { __relationKind: "many"; __target: "posts" } };
};
type RANK = { posts: never; users: never };
type SEARCH = { posts: never; users: never };

declare const db: DatabaseReaderFacade<DM, REL, RANK, SEARCH>;

const check = async (): Promise<void> => {
    const post = await db.posts.findFirst({ with: { author: { select: ["name"] } } });

    post?.author?.name;
    // @ts-expect-error `email` was not selected on the nested `author`
    post?.author?.email;

    const user = await db.users.findFirst({ with: { posts: { select: ["title"] } } });

    user?.posts[0]?.title;
    // @ts-expect-error `body` was not selected on the nested `posts`
    user?.posts[0]?.body;

    // No nested select → the full child stays accessible.
    const full = await db.posts.findFirst({ with: { author: true } });

    full?.author?.email;
};

export default check;
