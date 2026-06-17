import { GitFork, Heart, Star } from "lucide-react";

import AuroraMesh from "@/components/sections/aurora-mesh";
import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";
import HighlightLink from "@/components/ui/highlight-link";

const StatBadge = ({ icon: Icon, label }: { icon: typeof Star; label: string }) => (
    <div className="flex items-center gap-2 border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/55">
        <Icon className="size-4 text-white/40" />
        <span>{label}</span>
    </div>
);

const OpenSource = () => (
    <div className="bg-background relative overflow-hidden" data-theme="dark">
        <SectionDivider />
        <AuroraMesh placement="bottom" />
        <Section classes={{ childrenWrapper: "items-end", root: "relative z-10 pb-32" }} gridLength={0} mode="dark">
            <div className="col-span-2">
                <SectionHeader
                    eyebrow="Open Source"
                    subhead="Lunora is built in the open — a schema-first server and a live, typed client, so building a backend inspires instead of frustrates. Great tools lead to great products."
                    title="Proudly open source."
                />
                <div className="mt-6 flex flex-wrap gap-3">
                    <StatBadge icon={Star} label="FSL-1.1" />
                    <StatBadge icon={GitFork} label="Built on Cloudflare" />
                    <StatBadge icon={Heart} label="Community Driven" />
                </div>
            </div>
            <div className="hidden lg:col-span-1 lg:block" />
            <div className="col-span-1">
                <HighlightLink icon={<Star />} mode="dark" target="_blank" to="https://github.com/anolilab/lunora">
                    Star us on GitHub
                </HighlightLink>
            </div>
        </Section>
    </div>
);

export default OpenSource;
