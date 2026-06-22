import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import type { ComponentType, FC, ReactNode } from "react";

import schemaImg from "@/assets/studio/schema.png";
import timeTravelImg from "@/assets/studio/time-travel.png";
import CodeView from "@/components/sections/code-view";
import HatchSpacer from "@/components/sections/hatch-spacer";
import { ClosingCta, SectionHead } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import FrameworkStrip from "@/pages/home/sections/framework-strip";
import Hero from "@/pages/home/sections/hero";
import HowItWorks from "@/pages/home/sections/how-it-works";
import SupportSection from "@/pages/home/sections/support";

/**
 * Axon-style landing page in the Lunora brand (Geist + aurora accents): a
 * two-column hero, a trust strip, the interactive panel, a feature bento with
 * code/studio visuals, a steps + stats band, the Cloudflare platform grid,
 * support, and the closing CTA.
 */

interface Bento {
    code?: string[];
    desc: string;
    file?: string;
    image?: string;
    title: string;
}

const bento: Bento[] = [
    {
        code: ["export default defineSchema({", "  todos: defineTable({", "    text: v.string(),", "    done: v.boolean(),", "  }),", "});"],
        desc: "Schema, queries, and mutations in pure TypeScript — codegen keeps server and client in lockstep.",
        file: "lunora/schema.ts",
        title: "Everything is code",
    },
    {
        code: ["// subscribes once, re-renders on every change", "const todos = useQuery(api.todos.list);", "const add = useMutation(api.todos.add);"],
        desc: "Queries are subscriptions. Every mutation pushes live updates to all clients — with optimistic writes and an offline queue.",
        file: "Todos.tsx",
        title: "Realtime by default",
    },
    {
        code: ["export const messages = defineTable({", "  roomId: v.string(),", "  body: v.string(),", "}).shardBy('roomId');"],
        desc: "State lives in SQLite-backed Durable Objects at the edge. Shard by key, or go global to replicate reads across regions.",
        file: "lunora/schema.ts",
        title: "Edge-native & sharded",
    },
    {
        desc: "A local admin UI for schema, data, SQL, logs, and time-travel ships with every app — running against your live edge database.",
        image: schemaImg,
        title: "Studio included",
    },
    {
        code: ["export type Todo = {", "  _id: Id<'todos'>;", "  text: string;", "  done: boolean;", "};"],
        desc: "Types flow from server functions to the client via codegen. Rename a field and the client stops compiling.",
        file: "_generated/dataModel.ts",
        title: "End-to-end typed",
    },
    {
        desc: "Every shard is a SQLite database you can rewind — restore to any moment in the last 30 days, with no extra infrastructure.",
        image: timeTravelImg,
        title: "Rewind your data",
    },
];

const logos: { Icon: ComponentType<{ className?: string }>; name: string }[] = [
    { Icon: SiReact, name: "React" },
    { Icon: SiVuedotjs, name: "Vue" },
    { Icon: SiSvelte, name: "Svelte" },
    { Icon: SiSolid, name: "Solid" },
    { Icon: SiAstro, name: "Astro" },
    { Icon: SiVite, name: "Vite" },
];

const BentoVisual: FC<{ cell: Bento }> = ({ cell }) => {
    if (cell.image) {
        return (
            <div className="relative overflow-hidden border border-white/[0.08]">
                <img alt={`${cell.title} — Lunora Studio`} className="block h-44 w-full object-cover object-left-top" loading="lazy" src={cell.image} />
            </div>
        );
    }

    return <CodeView className="h-44" filename={cell.file ?? "lunora.ts"} lines={cell.code ?? []} />;
};

const Showcase: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
    <section className={`border-t border-white/[0.08] bg-[#0e0e11] ${className ?? ""}`} data-nav-theme="dark">
        {children}
    </section>
);

const Home: FC = () => (
    <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
        {/* vertical guide lines at the container edges, full page height */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
        />

        <Hero />
        <FrameworkStrip />

        <HatchSpacer />

        {/* feature bento */}
        <Showcase className="py-24">
            <div className="mx-auto max-w-6xl px-5 lg:px-0">
                <SectionHead
                    eyebrow="Features"
                    subtitle="Realtime, storage, types, and a studio — typed and edge-native by default."
                    title="Everything you need to ship realtime"
                />
                <div className="mt-14 grid grid-cols-1 gap-px border border-white/[0.08] md:grid-cols-2 lg:grid-cols-3 lg:border-x-0">
                    {bento.map((cell, index) => (
                        <Reveal className="flex flex-col gap-4 bg-white/[0.012] p-6" delay={(index % 3) * 0.05} key={cell.title}>
                            <div>
                                <h3 className="text-lg font-medium tracking-tight text-white">{cell.title}</h3>
                                <p className="mt-1.5 text-sm leading-relaxed text-white/50">{cell.desc}</p>
                            </div>
                            <div className="mt-auto">
                                <BentoVisual cell={cell} />
                            </div>
                        </Reveal>
                    ))}
                </div>
            </div>
        </Showcase>

        <HatchSpacer />

        {/* how it works */}
        <Showcase className="py-24">
            <div className="mx-auto max-w-6xl px-5 lg:px-0">
                <SectionHead eyebrow="How it works" subtitle="From a schema to a live, globally-synced backend in three steps." title="Define. Write. Ship." />
                <div className="mt-14">
                    <HowItWorks />
                </div>
            </div>
        </Showcase>

        <HatchSpacer />

        {/* integrations */}
        <Showcase className="py-24">
            <div className="mx-auto max-w-6xl px-5 lg:px-0">
                <SectionHead
                    eyebrow="Integrations"
                    subtitle="One framework, every frontend — Lunora ships live adapters for React, Vue, Svelte, Solid, and Astro, powered by a Vite-first dev experience."
                    title="Works with your entire stack"
                />
                <div className="mt-14 grid grid-cols-2 gap-px border border-white/[0.08] bg-white/[0.08] sm:grid-cols-3 lg:border-x-0">
                    {logos.map(({ Icon, name }) => (
                        <div
                            className="flex h-32 items-center justify-center gap-3 bg-[#0e0e11] text-white/30 transition-colors hover:text-white/70"
                            key={name}
                        >
                            <Icon className="size-6" />
                            <span className="text-xl font-medium tracking-tight">{name}</span>
                        </div>
                    ))}
                </div>
            </div>
        </Showcase>

        <HatchSpacer />

        <SupportSection />

        <HatchSpacer />

        <ClosingCta />
    </div>
);

export default Home;
