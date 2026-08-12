import { ConsentDialogLink } from "@c15t/react";
import DiscordLogoIcon from "@icons-pack/react-simple-icons/icons/SiDiscord.mjs";
import GitHubLogoIcon from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import type { FC, ReactNode } from "react";

import AnolilabText from "@/assets/anolilab_text.svg?react";
import LunoraLogo from "@/assets/lunora_logo.svg?react";
import FlickeringGrid from "@/components/ui/flickering-grid";
import { Kicker, Shell } from "@/kit/layout";
import type { FooterEntry } from "~/site.config";
import siteConfig from "~/site.config";

/** Site footer: a hairline grid of link columns, the brand, and socials. */

const SOCIAL_ICON: Record<string, ReactNode> = {
    Discord: <DiscordLogoIcon className="size-5" />,
    Discussions: <MessagesSquare className="size-5" />,
    GitHub: <GitHubLogoIcon className="size-5" />,
};

const FooterLink: FC<{ link: FooterEntry }> = ({ link }) => {
    const className = "flex flex-1 items-center border-b border-hairline px-6 py-5 text-blurb text-ink-muted transition-colors last:border-b-0 hover:text-ink";

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
    <footer className="relative border-t border-hairline bg-canvas" data-nav-theme="dark">
        <Shell className="grid grid-cols-2 border-hairline lg:grid-cols-[1fr_1fr_1fr_1.6fr_auto] lg:border-x" flush>
            {siteConfig.footer.columns.map((column) => (
                <div className="flex flex-col border-b border-hairline lg:border-r lg:border-b-0" key={column.title}>
                    {column.links.map((link) => (
                        <FooterLink key={link.title} link={link} />
                    ))}
                </div>
            ))}

            {/* center — brand over a particle field */}
            <div className="relative col-span-2 flex min-h-[16rem] items-center justify-center overflow-hidden border-b border-hairline lg:col-span-1 lg:border-r lg:border-b-0">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40">
                    <FlickeringGrid className="size-full" color="#6B7280" flickerChance={0.08} gridGap={3} maxOpacity={0.3} squareSize={2} />
                </div>
                <div className="relative z-10 flex items-center gap-2.5">
                    <LunoraLogo className="h-7 w-7" title={siteConfig.brand.name} />
                    <span className="text-h3 font-bold text-ink">{siteConfig.brand.name}</span>
                </div>
            </div>

            {/* socials */}
            <div className="col-span-2 flex border-b border-hairline lg:col-span-1 lg:flex-col lg:border-b-0">
                {siteConfig.social.map((social) => (
                    <a
                        aria-label={social.label}
                        className="flex flex-1 items-center justify-center border-hairline px-6 py-5 text-ink-faint transition-colors not-last:border-r hover:text-ink lg:not-last:border-r-0 lg:not-last:border-b"
                        href={social.href}
                        key={social.label}
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        {SOCIAL_ICON[social.icon]}
                    </a>
                ))}
            </div>
        </Shell>

        {/* Built by anolilab — do not touch */}
        <div className="border-t border-hairline py-12">
            <div className="container mx-auto flex flex-col items-center justify-center gap-6">
                <Kicker size="micro">Built by</Kicker>
                <a
                    className="h-full w-full cursor-pointer transition-opacity duration-300 hover:opacity-80"
                    href={siteConfig.builtBy.href}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <AnolilabText className="fill-ink" />
                </a>
            </div>
        </div>

        <div className="relative container mx-auto text-ink">
            <div className="flex flex-col items-center justify-between gap-4 border-b border-hairline py-12 text-blurb text-ink-faint sm:flex-row">
                <span>{siteConfig.footer.copyright}</span>
                <span>{siteConfig.footer.legal}</span>
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
