import { GitFork, Heart, Star } from "lucide-react";

import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";
import HighlightLink from "@/components/ui/highlight-link";

const StatBadge = ({ icon: Icon, label }: { icon: typeof Star; label: string }) => (
    <div className="flex items-center gap-2 border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-500">
        <Icon className="h-4 w-4 text-gray-400" />
        <span>{label}</span>
    </div>
);

const OpenSource = () => (
    <Section classes={{ childrenWrapper: "items-end", root: "pb-[240px]" }} mode="light">
        <div className="col-span-2">
            <SectionTitle
                description={
                    <span className="flex flex-col gap-6">
                        <span>
                            Lunora is built in the open. By combining a schema-first server with a live, typed client, we let developers build real-time
                            products with confidence and joy.
                        </span>
                        <span className="text-gray-400">
                            Our philosophy is simple: great tools lead to great products, and building a backend should inspire — not frustrate.
                        </span>
                        <div className="flex flex-wrap gap-3 pt-4">
                            <StatBadge icon={Star} label="MIT Licensed" />
                            <StatBadge icon={GitFork} label="Built on Cloudflare" />
                            <StatBadge icon={Heart} label="Community Driven" />
                        </div>
                    </span>
                }
                mode="light"
                prefix="Open Source"
                title="Proudly OpenSource."
            />
        </div>
        <div className="hidden lg:col-span-1 lg:block" />
        <div className="col-span-1">
            <HighlightLink icon={<Star />} target="_blank" to="https://github.com/anolilab/lunora">
                Star us on GitHub
            </HighlightLink>
        </div>
    </Section>
);

export default OpenSource;
