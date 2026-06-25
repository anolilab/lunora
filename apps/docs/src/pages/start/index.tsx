import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript.mjs";
import { ArrowRight } from "lucide-react";
import type { ComponentType, FC } from "react";

import AnalogLogo from "@/assets/frameworks/analog.svg?react";
import AstroLogo from "@/assets/frameworks/astro.svg?react";
import NuxtLogo from "@/assets/frameworks/nuxt.svg?react";
import TanstackLogo from "@/assets/frameworks/tanstack.svg?react";
import HatchSpacer from "@/components/sections/hatch-spacer";
import { ClosingCta, Pill, SectionHead } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import InstallCommand from "@/pages/start/install-command";

/**
 * `/start` — the Lunora starter-kits gallery. One install scaffolds a typed,
 * real-time Lunora backend wired into the framework you pick; only the frontend
 * changes between kits. Brand-consistent with the home page (Geist + aurora,
 * hairline grid, Reveal). Cards link to each template's source on GitHub.
 */

interface Template {
    /** Brand simple-icons render their hex via `color="default"`; framework SVGs carry their own fills. */
    brand?: boolean;
    category: string;
    description: string;
    Icon: ComponentType<{ className?: string; color?: string }>;
    name: string;
    /** The init --template value (also the templates directory name). */
    slug: string;
    stack: string;
}

const templates: Template[] = [
    {
        category: "Full-stack",
        description: "Full-stack React on TanStack Router, Start, and Query — typed loaders and live data from the edge to the component.",
        Icon: TanstackLogo,
        name: "TanStack Start",
        slug: "tanstack-start-react",
        stack: "React",
    },
    {
        category: "Full-stack",
        description: "The same TanStack Start power on SolidJS — fine-grained reactivity, no virtual DOM, instant updates.",
        Icon: TanstackLogo,
        name: "TanStack Start",
        slug: "tanstack-start-solid",
        stack: "Solid",
    },
    {
        brand: true,
        category: "SPA",
        description: "A React Router v7 SPA with file-based routes and Lunora's live queries wired straight into your loaders.",
        Icon: SiReact,
        name: "React Router",
        slug: "react-router",
        stack: "React",
    },
    {
        category: "Meta-framework",
        description: "Vue + Nuxt with Lunora mounted inside Nitro — one worker serving RPC, WebSockets, and your pages.",
        Icon: NuxtLogo,
        name: "Nuxt",
        slug: "nuxt",
        stack: "Vue",
    },
    {
        brand: true,
        category: "Meta-framework",
        description: "SvelteKit on Cloudflare with live stores, optimistic mutations, and reactive loaders out of the box.",
        Icon: SiSvelte,
        name: "SvelteKit",
        slug: "sveltekit",
        stack: "Svelte",
    },
    {
        category: "Meta-framework",
        description: "Astro islands with a React island bound to Lunora's reactive loaders — ship mostly-static, live where it counts.",
        Icon: AstroLogo,
        name: "Astro",
        slug: "astro",
        stack: "Islands",
    },
    {
        category: "Meta-framework",
        description: "Angular + AnalogJS, fully typed against your Lunora schema with RxJS-friendly live data.",
        Icon: AnalogLogo,
        name: "Analog",
        slug: "analog",
        stack: "Angular",
    },
    {
        brand: true,
        category: "Backend",
        description: "No UI framework — just a typed, real-time backend you can call from any client, mobile app, or service.",
        Icon: SiTypescript,
        name: "Standalone",
        slug: "standalone",
        stack: "TypeScript",
    },
];

const Start: FC = () => (
    <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
        {/* vertical guide lines at the container edges, full page height */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
        />

        {/* hero */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-80 opacity-60"
                style={{ background: "radial-gradient(60% 100% at 50% -10%, hsl(256 72% 68% / 0.18), transparent 70%)" }}
            />
            <Reveal className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-36 pb-16 text-center sm:pt-44">
                <span className="flex items-center gap-2 border border-white/12 px-3 py-1 font-mono text-xs text-white/60">
                    <span className="size-1.5 bg-sky-sapphire" />
                    Starter kits
                </span>
                <h1 className="text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">
                    Start with your{" "}
                    <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">stack.</span>
                </h1>
                <p className="max-w-xl text-base leading-relaxed text-white/55">
                    Pick a framework and <code className="font-mono text-white/70">lunora init</code> scaffolds a typed, real-time Lunora backend wired into it
                    — schema, functions, live data, and a one-command Cloudflare deploy. Then build.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                    <Pill primary to="/docs/getting-started">
                        Read the guide
                        <ArrowRight className="size-4" />
                    </Pill>
                    <Pill href="https://github.com/anolilab/lunora/tree/alpha/templates">Browse on GitHub</Pill>
                </div>
                <InstallCommand />
            </Reveal>
        </section>

        <HatchSpacer />

        {/* template gallery */}
        <section className="border-t border-white/[0.08] bg-[#0e0e11] py-20" data-nav-theme="dark">
            <div className="mx-auto max-w-6xl px-5 lg:px-0">
                <SectionHead
                    eyebrow="Templates"
                    subtitle="Every kit ships the same typed, live-syncing Lunora backend — only the frontend changes. One command and you're running on the edge."
                    title="Eight ways to start"
                />
                <div className="mt-14 grid grid-cols-1 gap-px border border-white/[0.08] bg-white/[0.08] sm:grid-cols-2 lg:grid-cols-3 lg:border-x-0">
                    {templates.map((template, index) => (
                        <Reveal className="bg-[#0e0e11]" delay={(index % 3) * 0.05} key={template.slug}>
                            <a
                                className="group flex h-full flex-col gap-4 p-6 transition-colors hover:bg-white/[0.025]"
                                href={`https://github.com/anolilab/lunora/tree/alpha/templates/${template.slug}`}
                                rel="noreferrer"
                                target="_blank"
                            >
                                <div className="flex items-center gap-3">
                                    <template.Icon className="size-7 shrink-0" color={template.brand ? "default" : undefined} />
                                    <div className="min-w-0">
                                        <h3 className="truncate text-base font-medium tracking-tight text-white">{template.name}</h3>
                                        <p className="font-mono text-xs text-white/40">{template.stack}</p>
                                    </div>
                                    <span className="ml-auto shrink-0 border border-white/10 px-2 py-0.5 font-mono text-[10px] tracking-wider text-white/35 uppercase">
                                        {template.category}
                                    </span>
                                </div>
                                <p className="text-sm leading-relaxed text-white/50">{template.description}</p>
                                <div className="mt-auto flex items-center justify-between border-t border-white/[0.08] pt-3.5">
                                    <code className="font-mono text-xs text-white/40">--template {template.slug}</code>
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-white/70 transition-colors group-hover:text-white">
                                        Use
                                        <ArrowRight className="size-3.5" />
                                    </span>
                                </div>
                            </a>
                        </Reveal>
                    ))}
                </div>
                <p className="mt-8 text-center font-mono text-xs text-white/35">
                    Pass <code className="text-white/60">--template &lt;name&gt;</code> to <code className="text-white/60">lunora init</code>, or browse each
                    kit&apos;s source on GitHub.
                </p>
            </div>
        </section>

        <HatchSpacer />

        <ClosingCta />
    </div>
);

export default Start;
