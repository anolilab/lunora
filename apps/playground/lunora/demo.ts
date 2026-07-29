import { internalMutation, v } from "./_generated/server.js";

/**
 * Seed the Studio demo data.
 *
 * Exists so every Studio feature has something to look at without hand-building
 * a dataset: a wide, high-volume table (column pinning, horizontal windowing,
 * search highlighting, date-range search), rows spread across several months
 * (so `2026-07` in the search box means something), and foreign keys pointing at
 * `users` and `channels` (so those tables show reverse-relation counts).
 *
 * Idempotent by count: re-running tops the table up to `count` rather than
 * duplicating, so `pnpm run seed` is safe to repeat.
 */

/** Deterministic pseudo-random, so a seeded database is reproducible run to run. */
const rand = (seed: number): (() => number) => {
    let state = seed;

    return () => {
        state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;

        return state / 4_294_967_296;
    };
};

const CATEGORIES = ["hardware", "software", "services", "support", "training"];
const STATUSES = ["active", "archived", "blocked", "draft", "pending"];
const REGIONS = ["apac", "emea", "latam", "namer"];
const CITIES = ["Amsterdam", "Berlin", "Lisbon", "Nairobi", "Osaka", "Toronto"];
const DEPARTMENTS = ["design", "engineering", "finance", "ops", "sales"];

export const seedDemo = internalMutation
    .input({ count: v.optional(v.number()), now: v.number() })
    .mutation(async ({ args, ctx }): Promise<{ created: number; total: number }> => {
        const target = Math.min(Math.max(args.count ?? 250, 1), 2000);
        const existing = await ctx.db.query("demoRecords").collect();

        if (existing.length >= target) {
            return { created: 0, total: existing.length };
        }

        // The demo rows need real ids to point at, so the reverse-relation
        // columns on `users` / `channels` have something to count.
        const users = await ctx.db.query("users").take(20);
        const channels = await ctx.db.query("channels").take(10);

        if (users.length === 0 || channels.length === 0) {
            throw new Error("seedDemo: create at least one user and one channel first (sign in and start a channel in the playground UI)");
        }

        const next = rand(20_260_729);
        // Spread across ~6 months so a `2026-07`-style search selects a real
        // subset rather than everything or nothing.
        const spanMs = 180 * 24 * 60 * 60 * 1000;
        // `now` arrives as an ARGUMENT, not `Date.now()`: mutation handlers must
        // be deterministic (the advisor enforces this), because a replayed or
        // retried mutation would otherwise write different timestamps.
        const { now } = args;
        let created = 0;

        for (let index = existing.length; index < target; index += 1) {
            const roll = next();
            const at = now - Math.floor(next() * spanMs);
            // Both lists are non-empty (guarded above) and the index is modulo
            // their length, so these are always in range.
            const { _id: channelId } = channels[index % channels.length];
            const { _id: ownerId } = users[index % users.length];

            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the seed deterministic and the write set small per step
            await ctx.db.insert("demoRecords", {
                amount: Math.round(roll * 100_000) / 100,
                category: CATEGORIES[index % CATEGORIES.length] ?? "",
                channelId,
                city: CITIES[index % CITIES.length] ?? "",
                code: `C-${String(1000 + index)}`,
                country: REGIONS[index % REGIONS.length] === "emea" ? "DE" : "US",
                createdAt: at,
                currency: index % 3 === 0 ? "EUR" : "USD",
                department: DEPARTMENTS[index % DEPARTMENTS.length] ?? "",
                description: `Demo record ${String(index)} for ${CATEGORIES[index % CATEGORIES.length] ?? ""} in ${CITIES[index % CITIES.length] ?? ""}`,
                email: `user${String(index % 40)}@example.com`,
                externalRef: `ext_${Math.floor(roll * 1_000_000).toString(36)}`,
                latitude: Math.round((next() * 180 - 90) * 1000) / 1000,
                longitude: Math.round((next() * 360 - 180) * 1000) / 1000,
                ...(index % 4 === 0 ? {} : { notes: `Follow up with ${CITIES[index % CITIES.length] ?? ""} before end of quarter.` }),
                ownerId,
                priority: (index % 5) + 1,
                quantity: (index % 25) + 1,
                region: REGIONS[index % REGIONS.length] ?? "",
                sku: `SKU-${String(index).padStart(5, "0")}`,
                status: STATUSES[index % STATUSES.length] ?? "",
                tags: [CATEGORIES[index % CATEGORIES.length], REGIONS[index % REGIONS.length]].join(","),
                title: `${DEPARTMENTS[index % DEPARTMENTS.length] ?? ""} record ${String(index)}`,
                updatedAt: at + 3_600_000,
            });

            created += 1;
        }

        return { created, total: target };
    });
