/**
 * Compile-time only (included by `tsc --noEmit`): dotted paths into an object column are typed keys of
 * `where` and `patch`, derived from the nested object types.
 */
import type { Id, OrderBy, PatchValues, Where } from "../src/data-model";

interface Row {
    _id: Id<"rows">;
    name: string;
    profile?: {
        address: { city: string; geo: { deep: { x: number }; lat: number } };
        age?: number;
        big: bigint;
        flags: { beta: boolean };
        joined: Date;
        plan: string;
        tags: string[];
    };
}

interface Plain {
    name: string;
}

const check = (): unknown[] => {
    const where: ReadonlyArray<Where<Row>> = [
        { "profile.plan": "pro" },
        { "profile.plan": { in: ["pro", "free"] } },
        { "profile.age": { gt: 20 } },
        { "profile.flags.beta": true },
        { "profile.address.geo.lat": { lte: 1 } },
        { name: "a", "profile.plan": "pro" },
        // @ts-expect-error -- the value must match the leaf's type
        { "profile.plan": 1 },
        // @ts-expect-error -- not a path the schema has
        { "profile.nope": "x" },
        // @ts-expect-error -- a path may have at most four segments
        { "profile.address.geo.deep.x": 1 },
        // @ts-expect-error -- an array leaf has no single comparison
        { "profile.tags": "x" },
        // @ts-expect-error -- neither does a date
        { "profile.joined": 1 },
        // @ts-expect-error -- nor a bigint
        { "profile.big": 1n },
        // @ts-expect-error -- nor a whole object
        { "profile.address": { city: "x" } },
    ];

    const patches: ReadonlyArray<PatchValues<Row>> = [
        { "profile.plan": "team" },
        { "profile.address.geo.lat": 2 },
        { "profile.address": { city: "x", geo: { deep: { x: 1 }, lat: 1 } } },
        { name: "b", "profile.plan": "team" },
        // @ts-expect-error -- the value must match the leaf's type
        { "profile.plan": 1 },
        // @ts-expect-error -- not a path the schema has
        { "profile.nope": "x" },
        // @ts-expect-error -- operators apply to a top-level column only
        { "profile.age": { increment: 1 } },
    ];

    // A branded id is a string, not an object: it offers no `_id.length` or `_id.__table` keys.
    // @ts-expect-error -- `_id` is not an object column
    const idPath: Where<Row> = { "_id.length": { gt: 3 } };

    const ordering: ReadonlyArray<OrderBy<Row>> = [
        { "profile.plan": "asc" },
        { "profile.address.geo.lat": "desc", name: "asc" },
        // @ts-expect-error -- only a scalar leaf can be sorted on
        { "profile.address": "asc" },
        // @ts-expect-error -- not a path the schema has
        { "profile.nope": "asc" },
    ];

    // A table with no object column keeps rejecting a key that names nothing.
    const plain: Where<Plain> = {
        // @ts-expect-error -- `missing` is neither a column nor a path
        missing: "x",
    };

    return [where, patches, plain, idPath, ordering];
};

export default check;
