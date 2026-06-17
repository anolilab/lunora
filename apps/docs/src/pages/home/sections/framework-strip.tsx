import SiAstro from "@icons-pack/react-simple-icons/icons/SiAstro.mjs";
import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import type { ComponentType, FC } from "react";

import Reveal from "@/components/sections/reveal";

const frameworks: { icon: ComponentType<{ className?: string }>; label: string }[] = [
    { icon: SiReact, label: "React" },
    { icon: SiVuedotjs, label: "Vue" },
    { icon: SiSvelte, label: "Svelte" },
    { icon: SiSolid, label: "Solid" },
    { icon: SiAstro, label: "Astro" },
];

const FrameworkStrip: FC = () => (
    <div className="bg-background border-y border-white/[0.06]" data-theme="dark">
        <Reveal className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-5 py-7 sm:flex-row sm:justify-between">
            <span className="font-mono text-[11px] tracking-[0.18em] text-white/50 uppercase">Works with your stack</span>
            <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
                {frameworks.map(({ icon: Icon, label }) => (
                    <span className="flex items-center gap-2 text-white/65 transition-colors hover:text-white" key={label}>
                        <Icon aria-hidden="true" className="size-4" />
                        <span className="text-sm font-medium">{label}</span>
                    </span>
                ))}
                <span className="hidden h-4 w-px bg-white/10 sm:block" />
                <span className="flex items-center gap-2 text-white/65 transition-colors hover:text-white">
                    <SiCloudflare aria-hidden="true" className="size-4" />
                    <span className="text-sm font-medium">on Cloudflare</span>
                </span>
            </div>
        </Reveal>
    </div>
);

export default FrameworkStrip;
