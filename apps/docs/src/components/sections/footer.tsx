import { ConsentDialogLink } from "@c15t/react";
import DiscordLogoIcon from "@icons-pack/react-simple-icons/icons/SiDiscord.mjs";
import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import AnolilabText from "@/assets/anolilab_text.svg?react";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import FlickeringGrid from "@/components/ui/flickering-grid";

type TanstackLink = { title: string; to: string };
type ExternalLinkType = { href: string; title: string };
type ConsentDialogEntry = { consentDialog: true; title: string };
type FooterEntry = ConsentDialogEntry | ExternalLinkType | TanstackLink;

const columns: { links: FooterEntry[]; title: string }[] = [
    {
        links: [
            { title: "Server", to: "/packages/server" },
            { title: "Client", to: "/packages/client" },
            { title: "React", to: "/packages/react" },
            { title: "All packages", to: "/packages" },
        ],
        title: "Packages",
    },
    {
        links: [
            { title: "Getting started", to: "/docs/getting-started" },
            { title: "Documentation", to: "/docs" },
            { title: "Lunora Cloud", to: "/cloud" },
            { title: "Compare", to: "/compare" },
            { title: "Blog", to: "/blog" },
            { title: "Changelog", to: "/changelog" },
        ],
        title: "Developers",
    },
    {
        links: [
            { title: "Privacy", to: "/privacy" },
            { consentDialog: true, title: "Cookie settings" },
            { title: "Code of Conduct", to: "/code-of-conduct" },
            { title: "Imprint", to: "/imprint" },
            { title: "Press & Brand", to: "/press" },
        ],
        title: "Legal",
    },
];

const socials: { href: string; icon: ReactNode; label: string }[] = [
    { href: "https://github.com/anolilab/lunora", icon: <GitHubLogoIcon className="size-5" />, label: "GitHub" },
    { href: "https://discord.gg/eajEZvk2PG", icon: <DiscordLogoIcon className="size-5" />, label: "Discord" },
    { href: "https://github.com/anolilab/lunora/discussions", icon: <MessagesSquare className="size-5" />, label: "Discussions" },
];

const FooterLink: FC<{ link: FooterEntry }> = ({ link }) => {
    const className =
        "flex flex-1 items-center border-b border-white/[0.08] px-6 py-5 text-sm text-white/55 transition-colors last:border-b-0 hover:text-white";

    if ("consentDialog" in link) {
        return <ConsentDialogLink className={`${className} cursor-pointer`}>{link.title}</ConsentDialogLink>;
    }

    if ("href" in link) {
        return (
            <a className={className} href={link.href} rel="noopener noreferrer" target="_blank">
                {link.title}
            </a>
        );
    }

    return (
        <Link className={className} to={link.to}>
            {link.title}
        </Link>
    );
};

const Footer: FC = () => (
    <footer className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
        <div className="mx-auto grid max-w-6xl grid-cols-2 border-white/[0.08] lg:grid-cols-[1fr_1fr_1fr_1.6fr_auto] lg:border-x">
            {columns.map((column) => (
                <div className="flex flex-col border-b border-white/[0.08] lg:border-r lg:border-b-0" key={column.title}>
                    {column.links.map((link) => (
                        <FooterLink key={link.title} link={link} />
                    ))}
                </div>
            ))}

            {/* center — brand over a particle field */}
            <div className="relative col-span-2 flex min-h-[16rem] items-center justify-center overflow-hidden border-b border-white/[0.08] lg:col-span-1 lg:border-r lg:border-b-0">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40">
                    <FlickeringGrid className="size-full" color="#6B7280" flickerChance={0.08} gridGap={3} maxOpacity={0.3} squareSize={2} />
                </div>
                <div className="relative z-10 flex items-center gap-2.5">
                    <LunoraLogo className="h-7 w-7" title="Lunora" />
                    <span className="text-2xl font-semibold tracking-tight text-white">Lunora</span>
                </div>
            </div>

            {/* socials */}
            <div className="col-span-2 flex border-b border-white/[0.08] lg:col-span-1 lg:flex-col lg:border-b-0">
                {socials.map((social) => (
                    <a
                        aria-label={social.label}
                        className="flex flex-1 items-center justify-center border-white/[0.08] px-6 py-5 text-white/40 transition-colors not-last:border-r hover:text-white lg:not-last:border-r-0 lg:not-last:border-b"
                        href={social.href}
                        key={social.label}
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        {social.icon}
                    </a>
                ))}
            </div>
        </div>

        {/* Built by anolilab — do not touch */}
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
