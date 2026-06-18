import type { FC } from "react";

import GradientBars from "@/components/sections/gradient-bars";
import type { Feature } from "@/components/sections/langbase";
import { ClosingCta, CodePanel, ProductSection, QuoteBand, SectionMarker } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import FrameworkStrip from "@/pages/home/sections/framework-strip";
import HeroLangbase from "@/pages/home/sections/hero-langbase";
import SupportSection from "@/pages/home/sections/support";

/**
 * Langbase-style landing page (aurora-tinted, sharp): a black hero with the
 * gradient equalizer, then repeating `// label` product sections — each with a
 * faint AI-transcript column, centered marker + copy, and three feature cards
 * with gradient visuals — interleaved with code panels, an ecosystem wall, and
 * the closing CTA.
 */

const schemaFeatures: Feature[] = [
    { desc: "Schema, queries, and mutations in pure TypeScript — no DTOs, no drift.", title: "Everything is code" },
    { desc: "Codegen keeps the client and server in lockstep. Rename a field, the client stops compiling.", title: "End-to-end typed" },
    { desc: "v.* validators define shape and infer return types automatically.", title: "Validated by default" },
];

const realtimeFeatures: Feature[] = [
    { desc: "Queries are subscriptions — every mutation pushes live updates over WebSocket.", title: "Live by default" },
    { desc: "Mutations apply instantly on the client and reconcile when the server confirms.", title: "Optimistic updates" },
    { desc: "Offline writes queue durably and flush in order on reconnect.", title: "Offline queue" },
];

const edgeFeatures: Feature[] = [
    { desc: "State lives in SQLite-backed Durable Objects, running close to your users.", title: "Edge-native data" },
    { desc: "Partition by user, tenant, or room with a single chained .shardBy() call.", title: "Scale by sharding" },
    { desc: "Replicate reads across regions with .global() for low-latency everywhere.", title: "Global reads" },
];

const studioFeatures: Feature[] = [
    { desc: "Browse your schema and the typed data model that ships with every app.", title: "Schema" },
    { desc: "A full data browser and SQL editor over your live edge database.", title: "Data & SQL" },
    { desc: "Rewind any shard to any moment in the last 30 days from a bookmark.", title: "Time travel" },
];

const opsFeatures: Feature[] = [
    { desc: "Schema and query lints surface unindexed FKs and dead indexes before deploy.", title: "Advisors" },
    { desc: "Stream structured logs per function and per shard, live.", title: "Logs" },
    { desc: "An in-memory harness runs queries, mutations, and actions in CI.", title: "Testing" },
];

const schemaCode = [
    "import { defineSchema, defineTable, v } from 'lunora/server';",
    "",
    "export default defineSchema({",
    "  todos: defineTable({",
    "    text: v.string(),",
    "    completed: v.boolean(),",
    "  }).index('by_completed', ['completed']),",
    "});",
];

const realtimeCode = [
    "import { mutation, query, v } from 'lunora/server';",
    "",
    "export const list = query.query(",
    "  async ({ ctx }) => ctx.db.query('todos').collect(),",
    ");",
    "",
    "export const add = mutation",
    "  .input({ text: v.string() })",
    "  .mutation(async ({ ctx, args }) =>",
    "    ctx.db.insert('todos', { ...args, completed: false }),",
    "  );",
];

const ecosystem: Feature[] = [
    { desc: "useQuery / useMutation / useSubscription for React, Vue, Svelte, Solid, and Astro.", title: "Framework adapters" },
    { desc: "better-auth: email/password, OAuth, passkeys, 2FA, organizations.", title: "@lunora/auth" },
    { desc: "Workers AI on the Vercel AI SDK — ctx.ai on your actions.", title: "@lunora/ai" },
    { desc: "R2 typed buckets and signed URLs.", title: "@lunora/storage" },
    { desc: "runAfter / runAt and Cron Triggers via SchedulerDO.", title: "@lunora/scheduler" },
    { desc: "Provider-agnostic payments — Stripe-first, webhooks, entitlements.", title: "@lunora/payment" },
];

const Home: FC = () => (
    <div className="bg-black" data-theme="dark">
        <HeroLangbase />
        <FrameworkStrip />

        <QuoteBand
            quote="A backend should be a function you write, not infrastructure you operate. Lunora is what that looks like on the edge."
            source="Daniel Bannert · Creator of Lunora"
        />

        <ProductSection
            copy="Declare your tables once. Lunora generates the typed data model and keeps server and client in lockstep."
            cta="Build your schema"
            features={schemaFeatures}
            label="schema"
        />
        <section className="border-t border-white/[0.06] bg-black px-5 py-20" data-nav-theme="dark">
            <CodePanel filename="lunora/schema.ts" lines={schemaCode} />
        </section>

        <ProductSection
            copy="Queries are subscriptions and mutations push live. Add optimistic updates and an offline queue without writing any of it."
            cta="Go realtime"
            features={realtimeFeatures}
            label="realtime"
        />
        <section className="border-t border-white/[0.06] bg-black px-5 py-20" data-nav-theme="dark">
            <CodePanel filename="lunora/todos.ts" lines={realtimeCode} />
        </section>

        <ProductSection
            copy="Run state in SQLite-backed Durable Objects at the edge — shard by key, or go global to replicate reads across regions."
            cta="Deploy to the edge"
            features={edgeFeatures}
            label="edge"
        />

        <ProductSection
            copy="A local studio ships with every app — schema, data, SQL, logs, and time-travel against your live edge database."
            cta="Open the studio"
            features={studioFeatures}
            label="studio"
        />

        <ProductSection
            copy="Ship with confidence — advisors lint your schema, logs stream live, and a test harness runs your functions in CI."
            cta="Ship with confidence"
            features={opsFeatures}
            label="ops"
        />

        {/* ecosystem wall */}
        <section className="border-t border-white/[0.06] bg-black" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 py-24">
                <Reveal className="flex flex-col items-center gap-4 text-center">
                    <SectionMarker label="ecosystem" />
                    <p className="max-w-md text-base leading-relaxed text-white/55">
                        One install for the base, opt-in add-ons for everything else — auth, AI, storage, payments, and more.
                    </p>
                </Reveal>
                <div className="mt-16 grid gap-px border border-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
                    {ecosystem.map((feature, index) => (
                        <Reveal
                            className="group flex flex-col gap-3 bg-white/[0.012] p-5 transition-colors hover:bg-white/[0.028]"
                            delay={(index % 3) * 0.05}
                            key={feature.title}
                        >
                            <h3 className="font-mono text-sm font-normal text-white">
                                <span className="text-white/30">// </span>
                                {feature.title}
                            </h3>
                            <p className="text-xs leading-relaxed text-white/45">{feature.desc}</p>
                            <GradientBars className="mt-2 h-20 w-full opacity-90 transition-opacity group-hover:opacity-100" rows={5} seed={(index + 1) * 70} />
                        </Reveal>
                    ))}
                </div>
            </div>
        </section>

        <SupportSection />

        <ClosingCta />
    </div>
);

export default Home;
