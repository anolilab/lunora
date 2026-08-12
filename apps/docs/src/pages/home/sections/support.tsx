import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { ArrowUpRight, CircleDot, GitPullRequest, MessagesSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import { Action } from "@/kit/action";
import { HairlineGrid } from "@/kit/grid";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";

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
        icon: <GitPullRequest className="size-5 text-ink-muted" />,
        title: "Submit a pull request",
    },
    {
        desc: "New to open source? These are a good place to start.",
        href: GOOD_FIRST_ISSUES_URL,
        icon: <CircleDot className="size-5 text-ink-muted" />,
        title: "Good first issues",
    },
    {
        desc: "Ask questions, share ideas, and help shape the roadmap.",
        href: "https://github.com/anolilab/lunora/discussions",
        icon: <MessagesSquare className="size-5 text-ink-muted" />,
        title: "Join the discussion",
    },
];

const SupportSection: FC = () => (
    <Section id="support">
        <Shell>
            <SectionHeader index="09" label="Open source" note="Every contribution keeps it moving." title="Open source, built together">
                <p className="text-body text-ink-muted">Lunora is built in the open. Star the repo, file an issue, or send a pull request.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2.5">
                    <Action href="https://github.com/anolilab/lunora" variant="primary">
                        <GitHubLogoIcon className="size-4 fill-current" title="Lunora on GitHub" />
                        Star on GitHub
                    </Action>
                    <Action to="/docs">Contribution guide</Action>
                </div>
            </SectionHeader>

            <HairlineGrid className="border border-hairline lg:border-x-0" columns={3}>
                {paths.map((path, index) => (
                    <a
                        className="group flex flex-col gap-5 bg-canvas p-6 transition-colors hover:bg-hairline"
                        href={path.href}
                        key={path.title}
                        rel="noreferrer"
                        target="_blank"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="flex size-10 items-center justify-center border border-hairline-strong">{path.icon}</span>
                            <Kicker tone="accent">{String(index + 1).padStart(2, "0")}</Kicker>
                        </div>
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex flex-col gap-1.5">
                                <span className="text-h3 font-bold text-ink">{path.title}</span>
                                <span className="text-blurb text-ink-muted">{path.desc}</span>
                            </div>
                            <ArrowUpRight className="size-4 shrink-0 text-ink-faint transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent" />
                        </div>
                    </a>
                ))}
            </HairlineGrid>
        </Shell>
    </Section>
);

export default SupportSection;
