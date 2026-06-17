import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import SiCloudflareworkers from "@icons-pack/react-simple-icons/icons/SiCloudflareworkers.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript.mjs";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import { ArrowRight, Database, HardDrive, Layers } from "lucide-react";
import type { ComponentType, FC } from "react";

import TanstackStartLogo from "@/assets/tanstack-start.svg?react";
import Reveal from "@/components/sections/reveal";
import Section from "@/components/sections/section";
import SectionDivider from "@/components/sections/section-divider";
import SectionHeader from "@/components/sections/section-header";

const frameworks: { icon: ComponentType<{ className?: string }>; label: string }[] = [
    { icon: SiReact, label: "React" },
    { icon: SiVuedotjs, label: "Vue" },
    { icon: SiSolid, label: "Solid" },
    { icon: SiSvelte, label: "Svelte" },
    { icon: SiAstro, label: "Astro" },
    { icon: SiVite, label: "Vite" },
    { icon: TanstackStartLogo, label: "TanStack" },
    { icon: SiTypescript, label: "TypeScript" },
];

const platforms: { icon: ComponentType<{ className?: string }>; label: string }[] = [
    { icon: SiCloudflareworkers, label: "Workers" },
    { icon: SiCloudflare, label: "Durable Objects" },
    { icon: Database, label: "D1" },
    { icon: HardDrive, label: "R2" },
    { icon: Layers, label: "Queues" },
];

const IconTile: FC<{ icon: ComponentType<{ className?: string }>; label: string }> = ({ icon: Icon, label }) => (
    <div className="group relative flex flex-col items-center gap-3 border border-white/[0.06] bg-white/[0.02] p-5 transition-all duration-300 hover:border-sky-sapphire/40 hover:bg-sky-sapphire/[0.05]">
        <Icon aria-hidden="true" className="size-6 text-white/40 transition-colors duration-300 group-hover:text-white" />
        <span className="font-mono text-[10px] text-white/40 transition-colors duration-300 group-hover:text-white/70">{label}</span>
    </div>
);

const WorksWhereYouWork: FC = () => (
    <div className="bg-background relative" data-theme="dark">
        <SectionDivider />
        <Section gridLength={0} mode="dark">
            <div className="col-span-full">
                <SectionHeader
                    eyebrow="Compatibility"
                    subhead="Lunora speaks your frontend and deploys to your own Cloudflare account."
                    title="Works where you work."
                />
            </div>

            <div className="col-span-full mt-14">
                <div className="grid gap-2.5 lg:grid-cols-2">
                    <Reveal className="border border-white/[0.08] bg-white/[0.015] p-8">
                        <div className="mb-6 flex items-center justify-between">
                            <h3 className="text-lg font-medium text-white">Client frameworks</h3>
                            <span className="border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-xs text-white/50">
                                useQuery
                                <span className="text-sky-sapphire">()</span>
                            </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-3">
                            {frameworks.map((fw) => (
                                <IconTile icon={fw.icon} key={fw.label} label={fw.label} />
                            ))}
                            <div className="flex items-center justify-center border border-white/[0.06] bg-white/[0.02] p-5 font-mono text-xs text-white/25">
                                +more
                            </div>
                        </div>
                    </Reveal>

                    <Reveal className="border border-white/[0.08] bg-white/[0.015] p-8" delay={0.1}>
                        <div className="mb-6 flex items-center justify-between">
                            <h3 className="text-lg font-medium text-white">Runs on Cloudflare</h3>
                            <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-400/80">
                                <span className="size-1.5 rounded-full bg-emerald-400" />
                                edge native
                            </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2.5">
                            {platforms.map((pl) => (
                                <IconTile icon={pl.icon} key={pl.label} label={pl.label} />
                            ))}
                        </div>

                        <div className="mt-6 flex items-center gap-2 border-t border-white/[0.06] pt-6">
                            <ArrowRight className="size-3.5 shrink-0 text-white/25" />
                            <span className="font-mono text-xs text-white/40">
                                Workers serve the RPC router; Durable Objects hold your state at the edge — in your own account.
                            </span>
                        </div>
                    </Reveal>
                </div>
            </div>
        </Section>
    </div>
);

export default WorksWhereYouWork;
