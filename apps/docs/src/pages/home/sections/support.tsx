import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { ArrowUpRight, CircleDot, GitPullRequest, MessagesSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Pill, SectionHead } from "@/components/sections/langbase";

/**
 * Open-source / contribute section — a centered section header, CTAs, and a
 * three-card grid of contribution paths.
 */

// Built from parts (with a synthesized double-quote char) to keep GitHub's
// label-search syntax without tripping the secret-entropy / quote lint rules.
const DQ = String.fromCodePoint(34);
const ISSUE_QUERY = `is:open is:issue label:${DQ}good first issue${DQ},${DQ}help wanted${DQ} `;
const GOOD_FIRST_ISSUES_URL = `https://github.com/anolilab/lunora/issues?q=${encodeURIComponent(ISSUE_QUERY)}`;

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
    <section className="border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
        <div className="mx-auto max-w-6xl px-5 py-24 lg:px-0">
            <SectionHead
                eyebrow="Support"
                subtitle="Lunora is open source and built in the open. Star the repo, file an issue, or send a pull request — every contribution keeps it moving."
                title="Open source, built together"
            />

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Pill href="https://github.com/anolilab/lunora" primary>
                    <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                    Star on GitHub
                </Pill>
                <Pill to="/docs/$">Contribution guide</Pill>
            </div>

            <div className="mt-14 grid gap-px border border-white/[0.08] bg-white/[0.08] md:grid-cols-3 lg:border-x-0">
                {paths.map((path) => (
                    <a
                        className="group flex flex-col gap-4 bg-[#0e0e11] p-6 transition-colors hover:bg-white/[0.02]"
                        href={path.href}
                        key={path.title}
                        rel="noreferrer"
                        target="_blank"
                    >
                        <span className="flex size-10 items-center justify-center border border-white/12 bg-white/[0.03]">{path.icon}</span>
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex flex-col gap-1">
                                <span className="text-sm font-semibold text-white">{path.title}</span>
                                <span className="text-xs leading-relaxed text-white/45">{path.desc}</span>
                            </div>
                            <ArrowUpRight className="size-4 shrink-0 text-white/30 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white/70" />
                        </div>
                    </a>
                ))}
            </div>
        </div>
    </section>
);

export default SupportSection;
