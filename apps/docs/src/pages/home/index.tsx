import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import { ArrowRight, Boxes, Gauge, LayoutDashboard, Terminal } from "lucide-react";
import type { ComponentType, FC, ReactNode } from "react";

import AnalogLogo from "@/assets/frameworks/analog.svg?react";
import AstroLogo from "@/assets/frameworks/astro.svg?react";
import NuxtLogo from "@/assets/frameworks/nuxt.svg?react";
import TanstackLogo from "@/assets/frameworks/tanstack.svg?react";
import schemaImg from "@/assets/studio/schema.png";
import timeTravelImg from "@/assets/studio/time-travel.png";
import AgentPanel from "@/components/sections/agent-panel";
import CodeView from "@/components/sections/code-view";
import HatchSpacer from "@/components/sections/hatch-spacer";
import Reveal from "@/components/sections/reveal";
import { Action } from "@/kit/action";
import { GridCell, HairlineGrid } from "@/kit/grid";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";
import { LinkRow, LinkRowList } from "@/kit/link-row";
import { cn } from "@/lib/utils";
import Capabilities from "@/pages/home/sections/capabilities";
import CompareBand from "@/pages/home/sections/compare-band";
import Faq from "@/pages/home/sections/faq";
import Hero from "@/pages/home/sections/hero";
import HowItWorks from "@/pages/home/sections/how-it-works";
import Studio from "@/pages/home/sections/studio";
import SupportSection from "@/pages/home/sections/support";
import siteConfig from "~/site.config";

/**
 * The landing page. Every band is a `Section` + `Shell` + `SectionHeader` from
 * `src/kit`; this file contributes content and ordering, never spacing or
 * colour. If a band here needs a bespoke padding value, the kit is wrong — fix
 * it there so the rest of the site inherits the correction.
 */

interface Feature {
    blurb: string;
    code?: string[];
    file?: string;
    image?: string;
    /** Mono line pinned to the cell's bottom edge. */
    readout: string;
    title: string;
}

const features: Feature[] = [
    {
        blurb: "Schema, queries, and mutations in pure TypeScript — codegen keeps server and client in lockstep.",
        code: ["export default defineSchema({", "  todos: defineTable({", "    text: v.string(),", "    done: v.boolean(),", "  }),", "});"],
        file: "lunora/schema.ts",
        readout: "defineSchema() -> _generated/",
        title: "Everything is code",
    },
    {
        blurb: "Queries are subscriptions. Every mutation pushes live updates to all clients — with optimistic writes and an offline queue.",
        code: ["// subscribes once, re-renders on every change", "const todos = useQuery(api.todos.list);", "const add = useMutation(api.todos.add);"],
        file: "Todos.tsx",
        readout: "useQuery() -> live",
        title: "Realtime by default",
    },
    {
        blurb: "State lives in SQLite-backed Durable Objects at the edge. Shard by key, or go global to replicate reads across regions.",
        code: ["export const messages = defineTable({", "  roomId: v.string(),", "  body: v.string(),", "}).shardBy('roomId');"],
        file: "lunora/schema.ts",
        readout: ".shardBy('roomId')",
        title: "Edge-native & sharded",
    },
    {
        blurb: "A local admin UI for schema, data, SQL, logs, and time-travel ships with every app — running against your live edge database.",
        image: schemaImg,
        readout: "lunora dev -> :5173/studio",
        title: "Studio included",
    },
    {
        blurb: "Types flow from server functions to the client via codegen. Rename a field and the client stops compiling.",
        code: ["export type Todo = {", "  _id: Id<'todos'>;", "  text: string;", "  done: boolean;", "};"],
        file: "_generated/dataModel.ts",
        readout: "Id<'todos'> | Doc<'todos'>",
        title: "End-to-end typed",
    },
    {
        blurb: "Every shard is a SQLite database you can rewind — restore to any moment in the last 30 days, with no extra infrastructure.",
        image: timeTravelImg,
        readout: "restore --at 30d",
        title: "Rewind your data",
    },
];

// `brand` simple-icons render their brand hex via `color="default"`; the
// downloaded official marks (Astro gradient, TanStack white emblem, Nuxt green,
// Analog red waveform) carry their own fills.
const runtimes: { brand?: boolean; Icon: ComponentType<{ className?: string; color?: string }>; name: string; to: string }[] = [
    { brand: true, Icon: SiReact, name: "React", to: "/docs/frameworks/react" },
    { brand: true, Icon: SiVuedotjs, name: "Vue", to: "/docs/frameworks/vue" },
    { brand: true, Icon: SiSvelte, name: "Svelte", to: "/docs/frameworks/svelte" },
    { brand: true, Icon: SiSolid, name: "Solid", to: "/docs/frameworks/solid" },
    { Icon: AstroLogo, name: "Astro", to: "/docs/frameworks/astro" },
    { Icon: TanstackLogo, name: "TanStack", to: "/docs/frameworks/tanstack" },
    { Icon: NuxtLogo, name: "Nuxt", to: "/docs/frameworks/nuxt" },
    { Icon: AnalogLogo, name: "Analog", to: "/docs/frameworks/analog" },
    { brand: true, Icon: SiVite, name: "Vite", to: "/docs/frameworks/vite" },
];

const TOOLS: { href?: string; icon: ReactNode; subtitle: string; title: string; to?: string }[] = [
    { icon: <LayoutDashboard />, subtitle: "Schema, data, SQL, logs, and time-travel.", title: "Studio", to: "/studio" },
    { icon: <Terminal />, subtitle: "Scaffold, migrate, seed, deploy, and inspect.", title: "CLI", to: "/packages/cli" },
    { icon: <Gauge />, subtitle: "Schema and query lints that catch problems early.", title: "Advisor", to: "/packages/advisor" },
    { icon: <Boxes />, subtitle: "Expose a deployment to your AI agents.", title: "MCP server", to: "/packages/mcp" },
];

const FeatureVisual: FC<{ feature: Feature; highlight?: boolean }> = ({ feature, highlight = false }) =>
    feature.image ? (
        <img
            alt={`${feature.title} — Lunora Studio`}
            className="block h-48 w-full object-cover object-left-top"
            height={1252}
            loading="lazy"
            src={feature.image}
            width={2048}
        />
    ) : (
        <CodeView
            className={cn("h-48 border-0", highlight && "opacity-95 mix-blend-luminosity")}
            filename={feature.file ?? "lunora.ts"}
            lines={feature.code ?? []}
        />
    );

const Home: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        {/* Vertical guide lines at the container edges, running the whole page.
            Sections meet them exactly (Shell drops its padding at `lg`), so a
            full-width grid inside one drops its own side borders there rather
            than drawing a second line on top.

            The rails run behind the hero's colour field rather than stopping
            above it — the field lifts itself over them (`z-30` in `PageHeader`).
            Ending the rails below the hero instead would take them off the
            promise grid too, which has no side borders of its own and relies on
            these for its outer edges. */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-shell -translate-x-1/2 border-x border-hairline lg:block"
        />

        <Hero />

        <HatchSpacer />

        <Section id="features">
            <Shell>
                <SectionHeader label="Framework" title="Everything you need to ship realtime">
                    <p className="text-body text-ink-muted">Realtime, storage, types, and a studio — with no glue code between them.</p>
                </SectionHeader>

                <HairlineGrid className="border border-b-0 border-hairline lg:border-x-0" columns={3}>
                    {features.map((feature, index) => (
                        <GridCell
                            blurb={feature.blurb}
                            highlight={index === 1}
                            key={feature.title}
                            readout={feature.readout}
                            stage={<FeatureVisual feature={feature} highlight={index === 1} />}
                            title={feature.title}
                        />
                    ))}
                </HairlineGrid>
            </Shell>
        </Section>

        <HatchSpacer />

        <Section id="playground" tone="deep">
            <Shell>
                <SectionHeader label="Playground" title="Copy, paste, ship.">
                    <p className="text-body text-ink-muted">A schema, a function, and a component — the whole round trip in one screen.</p>
                </SectionHeader>
            </Shell>
            <Shell>
                <Reveal>
                    <AgentPanel />
                </Reveal>
            </Shell>
        </Section>

        <HatchSpacer />

        <Section id="how-it-works">
            <Shell>
                <SectionHeader label="How it works" title="Define. Write. Ship.">
                    <p className="text-body text-ink-muted">From a schema to a live, globally-synced backend.</p>
                </SectionHeader>
                <HowItWorks />
            </Shell>
        </Section>

        <HatchSpacer />

        <Studio />

        <HatchSpacer />

        <Capabilities />

        <HatchSpacer />

        <Section id="docs">
            <Shell>
                <SectionHeader action={{ label: "Browse all docs", to: "/docs" }} label="Documentation" title="Choose your runtime">
                    <p className="text-body text-ink-muted">Start with the adapter built for your project.</p>
                </SectionHeader>

                <LinkRowList columns={4} layout="row">
                    {runtimes.slice(0, 4).map(({ brand, Icon, name, to }) => (
                        <LinkRow icon={<Icon aria-hidden="true" color={brand ? "default" : undefined} />} key={name} title={name} to={to} />
                    ))}
                </LinkRowList>

                <h3 className="mt-[clamp(2.5rem,2rem+2vw,4rem)] mb-5 text-h3 font-bold text-ink">Developer tools</h3>

                <LinkRowList>
                    {TOOLS.map((tool) => (
                        <LinkRow href={tool.href} icon={tool.icon} key={tool.title} subtitle={tool.subtitle} title={tool.title} to={tool.to} />
                    ))}
                </LinkRowList>
            </Shell>
        </Section>

        <HatchSpacer />

        <CompareBand />

        <HatchSpacer />

        <Faq />

        <HatchSpacer />

        <SupportSection />

        {/* Closing CTA */}
        <Section className="overflow-hidden" tone="deep">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-72 opacity-50"
                style={{ background: "radial-gradient(60% 100% at 50% 120%, var(--site-accent-2), transparent 70%)" }}
            />
            <Shell className="relative">
                <div className="flex max-w-2xl flex-col items-start gap-6">
                    <Kicker tone="accent">Get started</Kicker>
                    <h2 className="text-h1 font-bold text-balance text-ink">Ready to ship realtime apps?</h2>
                    <p className="text-body text-ink-muted">Open source, deployed to your own Cloudflare account, with no infrastructure to manage.</p>
                    <Action to={siteConfig.cta.primary.to} variant="primary">
                        {siteConfig.cta.primary.label}
                        <ArrowRight className="size-4" />
                    </Action>
                </div>
            </Shell>
        </Section>
    </div>
);

export default Home;
