import { ArrowRight, BookOpen, CircleDot, GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";

import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";
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
    iconColor = "text-gray-600",
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
        className={`group relative col-span-2 overflow-hidden border-y border-gray-200 bg-ivory transition-all duration-300 hover:bg-gray-50 ${className ?? ""}`}
    >
        {banner}
        <div className={`absolute top-0 right-0 left-0 h-px bg-gradient-to-r from-transparent ${accentColor} to-transparent`} />
        <div className="flex flex-col gap-4 p-8">
            <div className="flex items-start gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center border border-gray-200 bg-gray-50">
                    <Icon className={`size-5 ${iconColor}`} />
                </div>
                <div className="flex flex-col gap-2">
                    <h3 className="text-lg font-bold">{title}</h3>
                    <span className="text-sm leading-relaxed text-gray-500">{children}</span>
                </div>
            </div>
            {href && linkText && (
                <a
                    className={`group/link ml-14 inline-flex w-fit items-center gap-2 text-sm font-medium ${linkColor} transition-colors hover:text-gray-900`}
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
    <div className="bg-ivory" data-theme="light">
        <Section classes={{ root: "pb-0" }} gridLength={0} mode="light">
            <div className="col-span-2">
                <SectionTitle
                    description={
                        <span className="flex flex-col gap-4">
                            <span>
                                Community is the heart of open source. The success of our packages wouldn&apos;t be possible without the incredible
                                contributions of users, testers, and developers who collaborate with us every day.
                            </span>
                            <span className="text-gray-400">
                                Want to get involved? Here are some tips on how you can make a meaningful impact on our open source projects.
                            </span>
                        </span>
                    }
                    mode="light"
                    prefix="Support"
                    title="Contribute to our work and keep us going"
                />
            </div>
        </Section>
        <Section classes={{ root: "pt-20" }} gridLength={0} mode="light">
            <SupportCard accentColor="via-sky-sapphire/30" className="mr-px" icon={BookOpen} iconColor="text-sky-sapphire/70" title="Ready to help us out?">
                Be sure to check out the package&apos;s contribution guidelines first. They&apos;ll walk you through how to properly submit an issue or pull
                request to our repositories.
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
