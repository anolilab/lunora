import type { FC } from "react";

import bgStones from "@/assets/images/bg-stones.png";
import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";

const GuidelineItem = ({ children, color, title }: { children: React.ReactNode; color: string; title: string }) => (
    <div className="group relative flex flex-col gap-4 py-6 transition-all duration-300 hover:bg-white/[0.02]">
        <h3 className={`-ml-[1px] border-l-2 ${color} px-10 text-lg font-bold text-white transition-colors duration-300`}>{title}</h3>
        <p className="px-10 text-sm leading-relaxed text-white/40 transition-colors duration-300 group-hover:text-white/60">{children}</p>
    </div>
);

const GuidelineSection: FC = () => (
    <div className="bg-coal bg-bottom-left bg-no-repeat" style={{ backgroundImage: `url(${bgStones})` }}>
        <Section mode="dark" patternColor="royal-amethyst" patternPosition="top">
            <div className="col-span-1 mb-16 md:mb-0">
                <SectionTitle
                    description="We follow a set of guidelines to ensure that our open-source contributions maintain exceptional quality."
                    mode="dark"
                    prefix="Guideline"
                    title="The balancing act of open source."
                />
            </div>
            <div className="hidden lg:col-span-1 lg:block" />
            <div className="col-span-1 flex flex-col gap-16 lg:mt-24">
                <GuidelineItem color="border-sky-sapphire" title="Make it simple and enjoyable">
                    At Lunora, we believe building a backend should be as enjoyable as it is productive. The schema-first API is designed with simplicity and
                    elegance, ensuring that defining data and writing functions feels intuitive.
                </GuidelineItem>
                <GuidelineItem color="border-crimson-energy" title="Provide robust testing">
                    Reliability is at the core of everything we build. Each package is backed by a comprehensive test suite to guarantee seamless performance in
                    every environment, saving you time and building trust in production.
                </GuidelineItem>
                <GuidelineItem color="border-royal-amethyst" title="Be adaptable">
                    We understand that every project is unique. That's why Lunora is modular and extensible — start with a single Durable Object, then opt into
                    sharding, global replication, and add-ons that fit your exact requirements.
                </GuidelineItem>
            </div>
            <div className="col-span-1 mt-20 flex flex-col gap-16 md:mt-0">
                <GuidelineItem color="border-sky-sapphire" title="Craft clear documentation">
                    Great tools deserve great documentation. We invest in creating clear, detailed guides so you can quickly understand how to use our packages
                    and unlock their full potential.
                </GuidelineItem>
                <GuidelineItem color="border-crimson-energy" title="Write clean and readable code">
                    Code should speak for itself. We write clean, readable code with thoughtfully named variables and functions, making collaboration easier and
                    maintenance a breeze.
                </GuidelineItem>
                <GuidelineItem color="border-royal-amethyst" title="Focus on a small, polished scope">
                    Less is more. Our packages are intentionally focused on delivering one polished feature, ensuring simplicity, efficiency, and reliability
                    for your projects without unnecessary complexity.
                </GuidelineItem>
                <GuidelineItem color="border-sky-sapphire" title="Stay current">
                    The Cloudflare and Vite ecosystems evolve fast, and so do we. We keep Lunora compatible with the latest Workers, Durable Objects, and client
                    frameworks, so your projects always remain cutting-edge.
                </GuidelineItem>
            </div>
        </Section>
    </div>
);

export default GuidelineSection;
