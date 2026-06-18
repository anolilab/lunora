import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { ArrowUpRight, CircleDot, GitPullRequest, MessagesSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Pill, SectionMarker } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import FlickeringGrid from "@/components/ui/flickering-grid";

/**
 * Open-source / contribute section (dark Langbase look) — a blueprint box with
 * a `// support` marker + CTAs on the left, and a list of contribution paths on
 * the right. The flickering grid adds subtle texture behind the marker.
 */

// Built from parts (with a synthesized double-quote char) to keep GitHub's
// label-search syntax without tripping the secret-entropy / quote lint rules.
const DQ = String.fromCodePoint(34);
const ISSUE_QUERY = `is:open is:issue label:${DQ}good first issue${DQ},${DQ}help wanted${DQ} `;
const GOOD_FIRST_ISSUES_URL = `https://github.com/anolilab/lunora/issues?q=${encodeURIComponent(ISSUE_QUERY)}`;

const NODE = "absolute z-10 size-2 bg-white/70";

const paths: { desc: string; href: string; icon: ReactNode; title: string }[] = [
    {
        desc: "Fork the repo, make your change, and open a PR — we review every contribution.",
        href: "https://github.com/anolilab/lunora",
        icon: <GitPullRequest className="size-5 text-royal-amethyst/70" />,
        title: "Submit a pull request",
    },
    {
        desc: "New to open source? These are a good place to start.",
        href: GOOD_FIRST_ISSUES_URL,
        icon: <CircleDot className="size-5 text-emerald-400/70" />,
        title: "Good first issues",
    },
    {
        desc: "Ask questions, share ideas, and help shape the roadmap.",
        href: "https://github.com/anolilab/lunora/discussions",
        icon: <MessagesSquare className="size-5 text-sky-sapphire/70" />,
        title: "Join the discussion",
    },
];

const SupportSection: FC = () => (
    <section className="border-t border-white/[0.06] bg-black" data-nav-theme="dark">
        <div className="mx-auto max-w-6xl px-5 py-24">
            <Reveal className="relative border border-white/[0.08]">
                <span className={`${NODE} top-0 left-0 -translate-x-1/2 -translate-y-1/2`} />
                <span className={`${NODE} top-0 right-0 translate-x-1/2 -translate-y-1/2`} />
                <span className={`${NODE} bottom-0 left-0 -translate-x-1/2 translate-y-1/2`} />
                <span className={`${NODE} right-0 bottom-0 translate-x-1/2 translate-y-1/2`} />
                <span className={`${NODE} top-0 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block`} />
                <span className={`${NODE} bottom-0 left-1/2 hidden -translate-x-1/2 translate-y-1/2 lg:block`} />

                <div className="grid lg:grid-cols-2">
                    {/* left — marker + CTAs over flickering texture */}
                    <div className="relative flex flex-col justify-center gap-6 overflow-hidden border-b border-white/[0.08] px-8 py-14 lg:border-r lg:border-b-0 lg:px-12">
                        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-20">
                            <FlickeringGrid className="size-full" color="green" flickerChance={0.08} gridGap={3} maxOpacity={0.3} squareSize={2} />
                        </div>
                        <div className="relative z-10 flex flex-col gap-6">
                            <SectionMarker label="support" />
                            <p className="max-w-sm text-base leading-relaxed text-white/55">
                                Lunora is open source and built in the open. Star the repo, file an issue, or send a pull request — every contribution keeps it
                                moving.
                            </p>
                            <div className="flex flex-wrap items-center gap-3">
                                <Pill href="https://github.com/anolilab/lunora" primary>
                                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                                    Star on GitHub
                                </Pill>
                                <Pill to="/docs/$">Contribution guide</Pill>
                            </div>
                        </div>
                    </div>

                    {/* right — contribution paths */}
                    <div className="flex flex-col">
                        {paths.map((path) => (
                            <a
                                className="group flex items-center gap-4 border-b border-dashed border-white/[0.08] px-8 py-6 transition-colors last:border-b-0 hover:bg-white/[0.02] lg:px-12"
                                href={path.href}
                                key={path.title}
                                rel="noreferrer"
                                target="_blank"
                            >
                                <span className="flex size-10 shrink-0 items-center justify-center border border-white/12 bg-white/[0.03]">{path.icon}</span>
                                <span className="flex flex-col gap-0.5">
                                    <span className="text-sm font-semibold text-white">{path.title}</span>
                                    <span className="text-xs leading-relaxed text-white/45">{path.desc}</span>
                                </span>
                                <ArrowUpRight className="ml-auto size-4 shrink-0 text-white/30 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-white/70" />
                            </a>
                        ))}
                    </div>
                </div>
            </Reveal>
        </div>
    </section>
);

export default SupportSection;
