import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markerLine } from "../call-site-fixture";
import { createOwnerFieldFixture, expectReported, insert, ownerMutator, rowAt } from "./owner-field-writes-fixture";

describe("discoverOwnerFieldWrites: ctx rows changed after they are read", () => {
    const { discover, setUp, tearDown } = createOwnerFieldFixture();

    beforeEach(setUp);
    afterEach(tearDown);

    // A value ROOTED in the impl's `ctx` is server-scoped, even when `args`
    // feeds the query; a helper's result is not.
    it.each([
        ["a destructured `ctx.db.get` row", `const { ownerId } = await ctx.db.get(args.postId);\n        await ${insert("ownerId")}; // @write`],
        ["a member of a `ctx.db.get` row", `const post = await ctx.db.get(args.postId);\n        await ${insert("post.ownerId")}; // @write`],
        [
            "rows from a `let` bound to `ctx.db`",
            `let rows = await ctx.db.query("m").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();\n        await Promise.all(rows.map((r) => ${insert("r.userId")})); // @write`,
        ],
        [
            "rows from `Promise.all` over `ctx.db.get`",
            `const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));\n        for (const r of rows) {\n            await ${insert("r.ownerId")}; // @write\n        }`,
        ],
        [
            "`Object.values` of a row",
            `const row = await ctx.db.get(args.id);\n        for (const member of Object.values(row.members)) {\n            await ${insert("member")}; // @write\n        }`,
        ],
        [
            "ctx.db rows filtered on args",
            `const rows = await ctx.db.query("t").collect();\n        const mine = rows.filter((r) => r.orgId === args.orgId);\n        mine.forEach((r) => ${insert("r.userId")}); // @write`,
        ],
        // A call whose result is its callback's return value stays server-scoped while that value is the row's.
        [
            "a `then` returning the row's field",
            `const owner = await ctx.db.get(args.id).then((row) => row.ownerId);\n        await ${insert("owner")}; // @write`,
        ],
        [
            "a `find` over ctx.db rows",
            `const row = (await ctx.db.query("t").collect()).find((r) => r.orgId === args.orgId);\n        await ${insert("row.userId")}; // @write`,
        ],
        [
            "a `filter` over ctx.db rows",
            `const [row] = (await ctx.db.query("t").collect()).filter((r) => r.orgId === args.orgId);\n        await ${insert("row.userId")}; // @write`,
        ],
        [
            "a `withIndex` filtered on args",
            `const row = await ctx.db.query("t").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first();\n        await ${insert("row.userId")}; // @write`,
        ],
    ])("does not record a write from %s", (_label, body) => {
        expect.assertions(1);

        const source = ownerMutator(`        ${body}`);

        expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
    });

    it.each([
        // A ctx-rooted receiver does not make a callback's return value server-scoped.
        [
            "a `then` falling back to args",
            `const owner = await ctx.db.get(args.id).then((org) => org?.ownerId ?? args.targetUserId);\n        await ${insert("owner")}; // @write`,
        ],
        ["a `catch` returning args", `const owner = await ctx.db.get(args.id).catch(() => args.targetUserId);\n        await ${insert("owner")}; // @write`],
        [
            "a `map` over ctx.db rows returning args",
            `const ids = (await ctx.db.query("t").collect()).map(() => args.targetUserId);\n        for (const id of ids) {\n            await ${insert("id")}; // @write\n        }`,
        ],
        [
            "a `reduce` over ctx.db rows returning args",
            `const rows = await ctx.db.query("t").collect();\n        const owner = rows.reduce(() => args.targetUserId, null);\n        await ${insert("owner")}; // @write`,
        ],
        // `ctx.db.asId` and the `ctx.run*` results echo caller-chosen input: rooted in ctx, but not server-scoped.
        ["a `ctx.db.asId` of an arg", `await ${insert('ctx.db.asId("users", args.targetUserId)')}; // @write`],
        [
            "a const chain from `ctx.db.asId`",
            `const a = ctx.db.asId("users", args.targetUserId);\n        const b = a;\n        const c = b;\n        await ${insert("c")}; // @write`,
        ],
        ["a `ctx.runQuery` result", `const r = await ctx.runQuery("users:get", { id: args.targetUserId });\n        await ${insert("r.userId")}; // @write`],
        ["a `ctx.runMutation` result", `const r = await ctx.runMutation("users:make", args);\n        await ${insert("r.userId")}; // @write`],
        [
            "a helper's result",
            `const members = await getMembers(ctx, args.orgId);\n        for (const m of members) {\n            await ${insert("m.userId")}; // @write\n        }`,
        ],
        ["a `??` fallback from ctx to args", `await ${insert("ctx.auth.userId ?? args.targetUserId")}; // @write`],
        [
            "a `let` reassigned in a `try`",
            `let id = ctx.auth.userId;\n        try {\n            id = args.targetUserId;\n        } catch {}\n        await ${insert("id")}; // @write`,
        ],
        [
            "an object member written from args",
            `const o = { userId: ctx.auth.userId };\n        o.userId = args.targetUserId;\n        await ${insert("o.userId")}; // @write`,
        ],
        [
            "a list pushed from args",
            `const list = [];\n        list.push(args.targetUserId);\n        for (const x of list) {\n            await ${insert("x")}; // @write\n        }`,
        ],
        ["a map set from args", `const m = new Map();\n        m.set("u", args.targetUserId);\n        await ${insert('m.get("u")')}; // @write`],
        [
            "an object assigned from args",
            `const o = { userId: ctx.auth.userId };\n        Object.assign(o, { userId: args.targetUserId });\n        await ${insert("o.userId")}; // @write`,
        ],
        [
            "a nested function declaration's return",
            `function pick() {\n            return args.targetUserId;\n        }\n        await ${insert("pick()")}; // @write`,
        ],
        [
            "a generator closing over args",
            `function* gen() {\n            yield args.targetUserId;\n        }\n        for (const x of gen()) {\n            await ${insert("x")}; // @write\n        }`,
        ],
    ])("reports a write from %s", (_label, body) => {
        expect.assertions(2);

        const source = ownerMutator(`        ${body}`);

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    // A ctx row is server-scoped only while nothing could have changed it:
    // followed through `const` aliases, `for…of` variables, iterating
    // callbacks and nested functions, and failing closed on any call this
    // cannot read.
    const read = `const row = await ctx.db.get(args.postId);`;

    it.each([
        ["a write through a `const` alias", `${read}\n        const alias = row;\n        alias.ownerId = args.targetUserId;`],
        ["a write through a two-hop alias", `${read}\n        const a = row;\n        const b = a;\n        b.ownerId = args.targetUserId;`],
        ["a nested arrow writing its parameter", `${read}\n        const set = (r) => { r.ownerId = args.targetUserId; };\n        set(row);`],
        ["a nested `function` writing its parameter", `${read}\n        function set(r) { r.ownerId = args.targetUserId; }\n        set(row);`],
        ["an IIFE writing its parameter", `${read}\n        ((r) => { r.ownerId = args.targetUserId; })(row);`],
        [
            "a nested function handed an alias",
            `${read}\n        const alias = row;\n        const set = (r) => { r.ownerId = args.targetUserId; };\n        set(alias);`,
        ],
        // An opaque call can plant caller data in the row only when caller data reaches it too.
        ["an imported `merge(row, args)`", `${read}\n        merge(row, args);`],
        ["an imported `apply(row, { ownerId: args.x })`", `${read}\n        apply(row, { ownerId: args.targetUserId });`],
        ["an imported call spreading args", `${read}\n        apply(row, ...args.patches);`],
        ["an imported call handed an alias and args", `${read}\n        const alias = row;\n        merge(alias, args);`],
        ["a nested function passing it on with args", `${read}\n        const relay = (r) => merge(r, args);\n        relay(row);`],
        ["a caller-chosen callee", `${read}\n        args.fn(row);`],
        ["a computed callee keyed by args", `${read}\n        handlers[args.kind](row);`],
        // A same-file helper outside the impl is judged like an import: caller data must reach the call.
        ["a same-file helper outside the impl handed args", `${read}\n        stamp(row, args.targetUserId);`],
        ["a `let` alias", `${read}\n        let alias = row;\n        alias.ownerId = args.targetUserId;`],
        ["`Object.defineProperty`", `${read}\n        Object.defineProperty(row, "ownerId", { value: args.targetUserId });`],
        ["a constructor handed args", `${read}\n        new Normalizer(row, args);`],
        ["a template tag handed args", `${read}\n        normalize\`\${row}\${args.targetUserId}\`;`],
        [
            "a destructured element written later",
            `const { meta } = await ctx.db.get(args.postId);\n        meta.ownerId = args.targetUserId;\n        await ${insert("meta.ownerId")}; // @write`,
        ],
    ])("reports a ctx row's owner after %s", (_label, body) => {
        expect.assertions(2);

        const write = body.includes("// @write") ? "" : `\n        await ${insert("row.ownerId")}; // @write`;
        const source = `import { apply, handlers, merge, Normalizer, normalize } from "./helpers";\nfunction stamp(r, owner) { r.ownerId = owner; }\n${ownerMutator(`        ${body}${write}`)}`;

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    it.each([
        [
            "a `for…of` variable written from args",
            `const rows = await ctx.db.query("posts").collect();\n        for (const r of rows) {\n            r.ownerId = args.targetUserId;\n        }\n        await Promise.all(rows.map((r) => ${insert("r.ownerId")})); // @write`,
        ],
        [
            "an iterating callback written from args",
            `const rows = await ctx.db.query("posts").collect();\n        rows.forEach((r) => { r.ownerId = args.targetUserId; });\n        for (const r of rows) {\n            await ${insert("r.ownerId")}; // @write\n        }`,
        ],
        [
            "a callback parameter written before its own write",
            `const rows = await ctx.db.query("posts").collect();\n        await Promise.all(rows.map((r) => { r.ownerId = args.targetUserId; return ${insert("r.ownerId")}; })); // @write`,
        ],
        [
            "a spread into an unknown call",
            `const rows = await ctx.db.query("posts").collect();\n        normalize(args.mode, ...rows);\n        for (const r of rows) {\n            await ${insert("r.ownerId")}; // @write\n        }`,
        ],
    ])("reports ctx rows changed through %s", (_label, body) => {
        expect.assertions(2);

        const source = ownerMutator(`        ${body}`);

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    // A binding of a member path of the row holds the row's own nested object.
    it.each([
        ["a destructured nested object", `const { meta } = row;\n        meta.ownerId = args.targetUserId;`, "row.meta.ownerId"],
        ["a `const` bound to a member", `const m = row.meta;\n        m.ownerId = args.targetUserId;`, "row.meta.ownerId"],
        ["a `const` bound to an element access", `const m = row["meta"];\n        m.ownerId = args.targetUserId;`, "row.meta.ownerId"],
        ["a nested destructuring", `const { meta: { inner } } = row;\n        inner.ownerId = args.targetUserId;`, "row.meta.inner.ownerId"],
        ["a deep member path", `const inner = row.meta.inner;\n        inner.ownerId = args.targetUserId;`, "row.meta.inner.ownerId"],
        ["a `for…of` over a member", `for (const m of row.members) {\n            m.ownerId = args.targetUserId;\n        }`, "row.members[0].ownerId"],
        ["a destructured member handed to an imported call with args", `const { meta } = row;\n        merge(meta, args);`, "row.meta.ownerId"],
        ["a member handed to an imported call with args", `merge(row.meta, args);`, "row.meta.ownerId"],
    ])("reports a ctx row's nested owner changed through %s", (_label, statement, value) => {
        expect.assertions(2);

        const source = `import { merge } from "./helpers";\n${ownerMutator(`        ${read}\n        ${statement}\n        await ${insert(value)}; // @write`)}`;

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    it.each([["a reassigned primitive member destructure", `let { ownerId } = row;\n        ownerId = args.targetUserId;`]])(
        "keeps a ctx row's owner server-scoped after %s",
        (_label, statement) => {
            expect.assertions(1);

            const source = `import { merge } from "./helpers";\n${ownerMutator(`        ${read}\n        ${statement}\n        await ${insert("row.ownerId")}; // @write`)}`;

            expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
        },
    );

    it.each([
        ["`JSON.stringify`", `JSON.stringify(row);`],
        ["`console.log`", `console.log("post", row);`],
        ["a `ctx.*` call", `await ctx.scheduler.runAfter(0, "notify", row);`],
        ["a local function that only reads it", `const title = (r) => r.title;\n        title(row);`],
        ["a nested function writing a fixed value", `const touch = (r) => { r.seen = true; };\n        touch(row);`],
        ["a same-file helper outside the impl that only reads it", `describe(row);`],
        ["a `const` alias that is only read", `const alias = row;\n        console.log(alias.title);`],
        // The attacker controls `args`, not an imported helper's code: with no caller data
        // reaching the call, the helper has nothing of the caller's to plant.
        ["an imported `sendWelcome(row)`", `await sendWelcome(row);`],
        ["an imported call handed an alias and server data", `const alias = row;\n        await notify(alias, ctx.auth.userId);`],
        ["an imported constructor", `new Mailer(row);`],
        ["an imported callback over rows", `[row].forEach(sendWelcome);`],
        // A same-file helper outside the impl cannot see `args`: a constant write or a returned parameter plants nothing.
        ["a same-file guard that returns its parameter", `const checked = guard(row);\n        console.log(checked.title);`],
        ["a same-file helper that stamps a fixed value", `touchUpdatedAt(row);`],
    ])("keeps a ctx row server-scoped next to %s", (_label, statement) => {
        expect.assertions(1);

        const source = `import { Mailer, notify, sendWelcome } from "./mail";\nfunction describe(r) { return \`\${r.title}\`; }\nfunction guard(doc) { if (!doc) throw new Error("missing"); return doc; }\nfunction touchUpdatedAt(d) { d.updatedAt = Date.now(); }\n${ownerMutator(`        ${read}\n        ${statement}\n        await ${insert("row.ownerId")}; // @write`)}`;

        expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
    });

    // Array destructuring of a ctx row list follows its elements like an object pattern does.
    const list = `const members = await ctx.db.query("members").collect();`;

    it.each([
        ["an array-destructured element", `${list}\n        const [owner] = members;\n        await ${insert("owner.userId")}; // @write`],
        ["a nested array destructuring", `${list}\n        const [{ profile }] = members;\n        await ${insert("profile.userId")}; // @write`],
        [
            "a same-file guard over an array element",
            `${list}\n        const [owner] = members;\n        guard(owner);\n        await ${insert("owner.userId")}; // @write`,
        ],
    ])("keeps a ctx row list server-scoped through %s", (_label, body) => {
        expect.assertions(1);

        const source = `function guard(doc) { if (!doc) throw new Error("missing"); return doc; }\n${ownerMutator(`        ${body}`)}`;

        expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
    });

    it.each([
        [
            "an array-destructured element written from args",
            `${list}\n        const [owner] = members;\n        owner.userId = args.targetUserId;\n        await ${insert("owner.userId")}; // @write`,
        ],
        [
            "a same-file guard over an element handed args",
            `${list}\n        const [owner] = members;\n        guard(owner, args);\n        await ${insert("owner.userId")}; // @write`,
        ],
    ])("reports a ctx row list changed through %s", (_label, body) => {
        expect.assertions(2);

        const source = `function guard(doc) { if (!doc) throw new Error("missing"); return doc; }\n${ownerMutator(`        ${body}`)}`;

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    // Every other place a row can end up is either followed precisely or fails closed.
    const rows = `const rows = await ctx.db.query("posts").collect();`;
    const write = (value: string): string => `\n        await ${insert(value)}; // @write`;

    it.each([
        ["an object container", `${read}\n        const box = { r: row };\n        box.r.ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["an array container", `${read}\n        const list = [row];\n        list[0].ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["a `??` fallback", `${read}\n        const target = row ?? {};\n        target.ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["a conditional", `${read}\n        const target = args.flag ? row : row;\n        target.ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["an `await`", `${read}\n        const target = await row;\n        target.ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["an element access", `${rows}\n        const first = rows[0];\n        first.ownerId = args.targetUserId;${write("rows[0].ownerId")}`],
        [
            "`find`",
            `${rows}\n        const mine = rows.find((r) => r.orgId === args.orgId);\n        mine.ownerId = args.targetUserId;${write("rows[0].ownerId")}`,
        ],
        ["`filter`", `${rows}\n        const [mine] = rows.filter(Boolean);\n        mine.ownerId = args.targetUserId;${write("rows[0].ownerId")}`],
        ["`at`", `${rows}\n        rows.at(0).ownerId = args.targetUserId;${write("rows[0].ownerId")}`],
        [
            "`Object.values`",
            `${rows}\n        for (const r of Object.values(rows)) {\n            r.ownerId = args.targetUserId;\n        }${write("rows[0].ownerId")}`,
        ],
        [
            "a `map` returning the row",
            `${rows}\n        const same = rows.map((r) => r);\n        same[0].ownerId = args.targetUserId;${write("rows[0].ownerId")}`,
        ],
        ["a nested function returning it", `${read}\n        const pick = (r) => r;\n        pick(row).ownerId = args.targetUserId;${write("row.ownerId")}`],
        ["a container handed to an import with args", `${read}\n        merge({ r: row }, args);${write("row.ownerId")}`],
        ["a `yield`", `${read}\n        function* each() { yield row; }\n        void each;${write("row.ownerId")}`],
    ])("reports a ctx row reached through %s", (_label, body) => {
        expect.assertions(2);

        const source = `import { merge } from "./helpers";\n${ownerMutator(`        ${body}`)}`;

        expectReported(rowAt(discover(source), markerLine(source, "write")));
    });

    it.each([
        ["an element that is only read", `${rows}\n        const first = rows[0];\n        await ${insert("first.userId")}; // @write`],
        ["`find` only read", `${rows}\n        const mine = rows.find((r) => r.orgId === args.orgId);\n        await ${insert("mine.userId")}; // @write`],
        ["a `??` only read", `${read}\n        const target = row ?? {};\n        await ${insert("target.ownerId")}; // @write`],
        [
            "a container passed to a ctx call",
            `${read}\n        await ctx.db.insert("audit", { before: row });\n        await ${insert("row.ownerId")}; // @write`,
        ],
        ["the impl's own return", `${read}\n        await ${insert("row.ownerId")}; // @write\n        return { ...row };`],
        [
            "a condition and a comparison",
            `${read}\n        if (!row || row.ownerId === args.x) throw new Error("no");\n        await ${insert("row.ownerId")}; // @write`,
        ],
        ["a predicate callback", `${rows}\n        const live = rows.filter((r) => r.active);\n        await ${insert("live[0].userId")}; // @write`],
    ])("keeps a ctx row server-scoped when %s", (_label, body) => {
        expect.assertions(1);

        const source = ownerMutator(`        ${body}`);

        expect(rowAt(discover(source), markerLine(source, "write"))).toBeUndefined();
    });
});
