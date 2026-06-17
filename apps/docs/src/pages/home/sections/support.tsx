import { ArrowRight, BookOpen, CircleDot, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";

import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";
import FlickeringGrid from "@/components/ui/flickering-grid";

const GoodFirstIssueBanner = (
    <FlickeringGrid className="ml-0.5 w-full" color="green" flickerChance={0.1} gridGap={2} height={45} maxOpacity={0.3} squareSize={2} />
);

const SupportCard = ({
    accentColor,
    banner,
    children,
    className,
    href,
    icon: Icon,
    iconColor = "text-white/50",
    linkColor = "text-sky-sapphire",
    linkText,
    title,
}: {
    accentColor: string;
    banner?: ReactNode;
    children: ReactNode;
    className?: string;
    href?: string;
    icon: typeof BookOpen;
    iconColor?: string;
    linkColor?: string;
    linkText?: string;
    title: string;
}) => (
    <div
        className={`group relative col-span-2 overflow-hidden border-y border-white/[0.08] bg-white/[0.015] transition-all duration-300 hover:bg-white/[0.03] ${className ?? ""}`}
    >
        {banner}
        <div className={`absolute top-0 right-0 left-0 h-px bg-gradient-to-r from-transparent ${accentColor} to-transparent`} />
        <div className="flex flex-col gap-4 p-8">
            <div className="flex items-start gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center border border-white/10 bg-white/[0.03]">
                    <Icon className={`size-5 ${iconColor}`} />
                </div>
                <div className="flex flex-col gap-2">
                    <h3 className="text-lg font-medium text-white">{title}</h3>
                    <span className="text-sm leading-relaxed text-white/55">{children}</span>
                </div>
            </div>
            {href && linkText && (
                <a
                    className={`group/link ml-14 inline-flex w-fit items-center gap-2 text-sm font-medium ${linkColor} transition-colors hover:text-white`}
                    href={href}
                    rel="noreferrer"
                    target="_blank"
                >
                    {linkText}
                    <ArrowRight className="size-4 transition-transform group-hover/link:translate-x-1" />
                </a>
            )}
        </div>
    </div>
);

const SupportSection = () => (
    <div className="bg-background" data-theme="dark">
        <SectionDivider />
        <Section classes={{ root: "pb-0" }} gridLength={0} mode="dark">
            <div className="col-span-2">
                <SectionHeader
                    eyebrow="Support"
                    subhead="Community is the heart of open source — its success comes from the users, testers, and developers who collaborate with us. Here are some ways to make a meaningful impact."
                    title="Contribute to our work and keep us going"
                />
            </div>
        </Section>
        <Section classes={{ root: "pt-20" }} gridLength={0} mode="dark">
            <SupportCard accentColor="via-sky-sapphire/30" className="mr-px" icon={BookOpen} iconColor="text-sky-sapphire/70" title="Ready to help us out?">
                Be sure to check out the package's contribution guidelines first. They'll walk you through how to properly submit an issue or pull request to
                our repositories.
            </SupportCard>
            <div className="hidden lg:col-span-2 lg:block" />

            <div className="hidden lg:col-span-2 lg:block" />
            <SupportCard accentColor="via-royal-amethyst/30" icon={GitPullRequest} iconColor="text-royal-amethyst/70" title="Submit a pull request">
                Found something to improve? Fork the repo, make your changes, and open a PR. We review every contribution and provide feedback to help you get
                merged.
            </SupportCard>

            <SupportCard
                accentColor="via-emerald-500/30"
                banner={GoodFirstIssueBanner}
                className="mr-px"
                href="https://github.com/anolilab/lunora/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22%2C%22help+wanted%22+"
                icon={CircleDot}
                iconColor="text-emerald-400/70"
                linkColor="text-emerald-400"
                linkText="View good first issues"
                title="Good first issues"
            >
                Simple issues suited for people new to open source development, and often a good place to start working on a package.
            </SupportCard>
            <div className="hidden lg:col-span-2 lg:block" />
        </Section>
    </div>
);

export default SupportSection;
