import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Handshake } from "lucide-react";
import type { FC } from "react";

import AnolilabText from "@/assets/anolilab_text.svg?react";
import LineGrid from "@/components/sections/line-grid";
import FlickeringGrid from "@/components/ui/flickering-grid";
import HighlightLink from "@/components/ui/highlight-link";
import OssLight from "@/components/ui/svgs/oss-lights";

type TanstackLink = { title: string; to: string };
type ExternalLinkType = { href: string; title: string };

const Menus: {
    links: (ExternalLinkType | TanstackLink)[];
    title: string;
}[] = [
    {
        links: [
            { title: "Server", to: "/packages/server" },
            { title: "Client", to: "/packages/client" },
            { title: "React", to: "/packages/react" },
            { title: "Durable Objects", to: "/packages/do" },
            { title: "Vite Plugin", to: "/packages/vite" },
            { title: "Auth", to: "/packages/auth" },
            { title: "All Packages", to: "/packages" },
        ],
        title: "Packages",
    },
    {
        links: [
            { title: "Getting Started", to: "/docs/getting-started" },
            { title: "Documentation", to: "/docs" },
            { title: "Changelog", to: "/changelog" },
            { title: "Brand", to: "/brand" },
        ],
        title: "Developers",
    },
    {
        links: [
            { title: "Privacy Policy", to: "/privacy" },
            { title: "Code of Conduct", to: "/code-of-conduct" },
            { title: "Imprint", to: "/imprint" },
        ],
        title: "Legal",
    },
    {
        links: [
            { href: "https://github.com/anolilab/lunora", title: "GitHub" },
            { href: "https://github.com/anolilab/lunora/discussions", title: "Discussions" },
        ],
        title: "Community",
    },
];

const Footer: FC = () => (
    <footer className="bg-background relative" data-nav-theme="dark">
        <div className="absolute -top-64 right-0 left-0 mx-auto overflow-hidden">
            <OssLight className="mx-auto" />
        </div>

        <div className="relative container mx-auto grid grid-cols-2 gap-y-8 p-0 sm:grid-cols-3 md:grid-cols-4">
            <LineGrid mode="dark" />

            <HighlightLink className="border-0" href="https://github.com/anolilab/lunora" mode="dark" rel="noopener noreferrer" target="_blank">
                <GitHubLogoIcon />
                <span className="grow">GitHub</span>
                <ExternalLink />
            </HighlightLink>
            <HighlightLink className="border-0" href="https://github.com/anolilab/lunora/discussions" mode="dark" rel="noopener noreferrer" target="_blank">
                <Handshake />
                <span className="grow">Discussions</span>
                <ExternalLink />
            </HighlightLink>
        </div>

        <div className="relative container mx-auto grid grid-cols-2 gap-y-8 p-0 sm:grid-cols-3 md:grid-cols-4">
            <LineGrid mode="dark" />

            {Menus.map((menu) => (
                <div className="relative z-10 flex flex-col space-y-4 border-t border-t-white/[0.06] py-24" key={menu.title}>
                    <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-white/30">{menu.title}</h2>
                    <div className="flex flex-col space-y-2 text-sm">
                        {menu.links.map((link: TanstackLink | ExternalLinkType) =>
                            (link as ExternalLinkType).href ? (
                                <a
                                    className="text-white/50 transition-colors hover:text-white"
                                    href={(link as ExternalLinkType).href}
                                    key={link.title}
                                    rel="noopener noreferrer"
                                >
                                    {link.title}
                                </a>
                            ) : (
                                <Link className="text-white/50 transition-colors hover:text-white" key={link.title} to={(link as TanstackLink).to}>
                                    {link.title}
                                </Link>
                            ),
                        )}
                    </div>
                </div>
            ))}
        </div>

        <div className="border-t border-white/[0.06] py-12">
            <div className="container mx-auto flex flex-col items-center justify-center gap-6">
                <span className="font-mono text-xs tracking-wider text-white/25 uppercase">Built by</span>
                <a
                    className="h-full w-full cursor-pointer transition-opacity duration-300 hover:opacity-80"
                    href="https://anolilab.com?ref=lunora"
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <AnolilabText className="fill-white" />
                </a>
            </div>
        </div>

        <div className="relative container mx-auto text-white">
            <div className="flex flex-col items-center justify-between gap-4 border-b border-white/[0.06] py-12 text-xs text-white/45 sm:flex-row">
                <span>&copy; 2026&ndash;present Lunora &amp; Lunora Contributors</span>
                <span>Code: FSL-1.1-Apache-2.0. Visual Design &amp; Branding: All Rights Reserved (CC BY-NC-ND 4.0).</span>
            </div>
            <div className="absolute inset-0 z-10" style={{ maskImage: "radial-gradient(85% 100% at 50% 100%, white, transparent 72.5%)" }}>
                <FlickeringGrid
                    className="absolute inset-0 h-full w-full"
                    color="#6B7280"
                    flickerChance={0.1}
                    gridGap={2}
                    height={117}
                    maxOpacity={0.3}
                    squareSize={2}
                />
            </div>
        </div>
    </footer>
);

export default Footer;
