import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import SiCloudflarepages from "@icons-pack/react-simple-icons/icons/SiCloudflarepages.mjs";
import SiCloudflareworkers from "@icons-pack/react-simple-icons/icons/SiCloudflareworkers.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript.mjs";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { useState } from "react";

import TanstackStartLogo from "@/assets/tanstack-start.svg?react";
import Section from "@/components/sections/section";
import SectionTitle from "@/components/sections/section-title";

const frameworks = [
    { icon: SiReact, label: "React" },
    { icon: SiVuedotjs, label: "Vue" },
    { icon: SiSolid, label: "Solid" },
    { icon: SiSvelte, label: "Svelte" },
    { icon: SiAstro, label: "Astro" },
    { icon: SiVite, label: "Vite" },
    { icon: TanstackStartLogo, label: "TanStack" },
    { icon: SiTypescript, label: "TypeScript" },
];

const platforms = [
    { icon: SiCloudflareworkers, label: "Workers" },
    { icon: SiCloudflare, label: "Durable Objects" },
    { icon: SiCloudflarepages, label: "Pages" },
];

const IconTile: FC<{ icon: any; index: number; label: string }> = ({ icon: Icon, index, label }) => {
    const [hovered, setHovered] = useState(false);

    return (
        <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="group relative flex flex-col items-center gap-3 border border-gray-200 bg-gray-50 p-5 transition-all duration-300 hover:border-sky-sapphire/40 hover:bg-sky-sapphire/[0.04]"
            initial={{ opacity: 0, y: 10 }}
            onMouseEnter={() => {
                setHovered(true);
            }}
            onMouseLeave={() => {
                setHovered(false);
            }}
            transition={{ delay: 0.8 + index * 0.04, duration: 0.4 }}
        >
            <Icon aria-hidden="true" className="h-6 w-6 text-gray-400 transition-colors duration-300 group-hover:text-gray-800" size={24} />
            <span className="font-mono text-[10px] text-gray-400 transition-colors duration-300 group-hover:text-gray-600">{label}</span>
            {hovered && (
                <motion.div
                    animate={{ scaleX: 1 }}
                    className="absolute -bottom-px left-0 right-0 h-px bg-sky-sapphire/50"
                    initial={{ scaleX: 0 }}
                    transition={{ duration: 0.2 }}
                />
            )}
        </motion.div>
    );
};

const WorksWhereYouWork: FC = () => (
    <div className="bg-white">
        <Section mode="light">
            <SectionTitle mode="light" prefix="Compatibility" title="Works where you work." />

            <div className="col-span-4 mt-16">
                <div className="grid gap-px lg:grid-cols-2">
                    <div className="border-y border-gray-200 bg-white p-8 mr-0.5">
                        <div className="mb-6 flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-gray-900">Client frameworks</h3>
                            <span className="border border-gray-200 bg-gray-50 px-3 py-1 font-mono text-xs text-gray-500">
                                useQuery
                                <span className="text-sky-sapphire">()</span>
                            </span>
                        </div>

                        <div className="grid grid-cols-4 gap-px sm:grid-cols-6">
                            {frameworks.map((fw, index) => (
                                <IconTile icon={fw.icon} index={index} key={fw.label} label={fw.label} />
                            ))}
                            <div className="flex items-center justify-center border border-gray-200 bg-gray-50 p-5 font-mono text-xs text-gray-300">+more</div>
                        </div>
                    </div>

                    <div className="border-y border-gray-200 bg-white p-8">
                        <div className="mb-6 flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-gray-900">Runs on Cloudflare</h3>
                            <div className="flex items-center gap-1.5 font-mono text-xs text-emerald-600">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                edge native
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-px sm:grid-cols-3">
                            {platforms.map((pl, index) => (
                                <IconTile icon={pl.icon} index={index + frameworks.length} key={pl.label} label={pl.label} />
                            ))}
                        </div>

                        <div className="mt-6 flex items-center gap-2 border-t border-gray-100 pt-6">
                            <ArrowRight className="h-3.5 w-3.5 text-gray-300" />
                            <span className="font-mono text-xs text-gray-400">
                                Lunora deploys to your own Cloudflare account — Workers serve the RPC router, Durable Objects hold your state at the edge.
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </Section>
    </div>
);

export default WorksWhereYouWork;
