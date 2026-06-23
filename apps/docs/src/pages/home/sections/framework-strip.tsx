import SiCloudflare from "@icons-pack/react-simple-icons/icons/SiCloudflare.mjs";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact.mjs";
import SiSolid from "@icons-pack/react-simple-icons/icons/SiSolid.mjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte.mjs";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs.mjs";
import type { ComponentType, FC } from "react";

import AnalogLogo from "@/assets/frameworks/analog.svg?react";
import AstroLogo from "@/assets/frameworks/astro.svg?react";
import NuxtLogo from "@/assets/frameworks/nuxt.svg?react";
import TanstackLogo from "@/assets/frameworks/tanstack.svg?react";
import Reveal from "@/components/sections/reveal";

// Brand-colored marks. The `@icons-pack/react-simple-icons` glyphs render their
// brand hex when given `color="default"` (flagged with `brand`); the downloaded
// brand SVGs (official Astro gradient, TanStack white emblem, Nuxt green, Analog
// red waveform) carry their own fills, so they render in color without a `color` prop.
interface Framework {
    brand?: boolean;
    icon: ComponentType<{ className?: string; color?: string }>;
    label: string;
}

const frameworks: Framework[] = [
    { brand: true, icon: SiReact, label: "React" },
    { brand: true, icon: SiVuedotjs, label: "Vue" },
    { brand: true, icon: SiSvelte, label: "Svelte" },
    { brand: true, icon: SiSolid, label: "Solid" },
    { icon: AstroLogo, label: "Astro" },
    { icon: TanstackLogo, label: "TanStack" },
    { icon: NuxtLogo, label: "Nuxt" },
    { icon: AnalogLogo, label: "Analog" },
];

const FrameworkStrip: FC = () => (
    <div className="border-t border-white/[0.08]" data-nav-theme="dark">
        <Reveal className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-5 py-7 sm:flex-row sm:justify-between">
            <span className="font-mono text-[11px] tracking-[0.18em] text-white/50 uppercase">Works with your stack</span>
            <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
                {frameworks.map(({ brand, icon: Icon, label }) => (
                    <span className="flex items-center gap-2 text-white/65 transition-colors hover:text-white" key={label}>
                        <Icon aria-hidden="true" className="size-4" color={brand ? "default" : undefined} />
                        <span className="text-sm font-medium">{label}</span>
                    </span>
                ))}
                <span className="hidden h-4 w-px bg-white/10 sm:block" />
                <span className="flex items-center gap-2 text-white/65 transition-colors hover:text-white">
                    <SiCloudflare aria-hidden="true" className="size-4" color="default" />
                    <span className="text-sm font-medium">on Cloudflare</span>
                </span>
            </div>
        </Reveal>
    </div>
);

export default FrameworkStrip;
