import { Heart, MoveUpRight } from "lucide-react";
import type { FC } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Action } from "@/kit/action";
import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";

import { faq, funds, reasons, SPONSOR_EMAIL, SPONSOR_URL, sponsors, tiers } from "./data";

/**
 * Sponsors page. Static on purpose: GitHub Sponsors is the checkout, this page
 * is the explanation and the logo wall. Content lives in `./data.ts`.
 */

const SponsorCta: FC = () => (
    <div className="flex flex-wrap items-center gap-2.5">
        <Action href={SPONSOR_URL} variant="primary">
            <Heart className="size-4" />
            Become a sponsor
        </Action>
        <Action href={`mailto:${SPONSOR_EMAIL}`}>Talk to us</Action>
    </div>
);

const Sponsors: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        <ArticleHeader
            actions={<SponsorCta />}
            breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Sponsors" }]}
            lead="Lunora is free, open source, and maintained in the open. Sponsorships keep the framework, Studio, docs, and adapters moving."
            meta="Sponsors"
            title="Support Lunora"
        />

        <HatchSpacer />

        <Section id="why" tone="canvas">
            <Shell>
                <SectionHeader label="Why sponsor" title="The realtime backend that runs on your Cloudflare account.">
                    <p className="text-body text-ink-muted">Your support decides how much time goes into it.</p>
                </SectionHeader>
                <ul className="grid grid-cols-1 gap-px bg-hairline md:grid-cols-2">
                    {reasons.map((reason) => (
                        <li className="bg-canvas p-6 sm:p-8" key={reason.title}>
                            <h3 className="text-h3 font-bold text-ink">{reason.title}</h3>
                            <p className="mt-1.5 text-blurb text-ink-muted">{reason.text}</p>
                        </li>
                    ))}
                </ul>
            </Shell>
        </Section>

        <Section id="sponsors" tone="canvas">
            <Shell>
                <SectionHeader label="Current sponsors" title="Thank you.">
                    <p className="text-body text-ink-muted">Logos link to the sponsors&apos; sites.</p>
                </SectionHeader>
                {sponsors.length > 0 ? (
                    <ul className="grid grid-cols-2 gap-px bg-hairline sm:grid-cols-3 lg:grid-cols-4">
                        {sponsors.map((sponsor) => (
                            <li className="bg-canvas" key={sponsor.name}>
                                <a
                                    className="flex h-28 items-center justify-center p-6 opacity-60 grayscale transition hover:opacity-100 hover:grayscale-0"
                                    href={sponsor.href}
                                    rel="noopener noreferrer sponsored"
                                    target="_blank"
                                >
                                    <img alt={sponsor.name} className="max-h-full w-auto" loading="lazy" src={sponsor.logo} />
                                </a>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="border border-hairline p-8 sm:p-10">
                        <Kicker tone="accent">Be the first</Kicker>
                        <p className="mt-3 max-w-xl text-body text-ink-muted">
                            Lunora is in alpha and the wall is empty. An early sponsor is the first logo here, and the one that stays.
                        </p>
                    </div>
                )}
            </Shell>
        </Section>

        <Section id="tiers" tone="canvas">
            <Shell>
                <SectionHeader label="Tiers" title="Monthly, through GitHub Sponsors.">
                    <p className="text-body text-ink-muted">Companies usually start at $25.</p>
                </SectionHeader>
                <div className="grid grid-cols-1 gap-px bg-hairline md:grid-cols-2 lg:grid-cols-5">
                    {tiers.map((tier) => (
                        <div className="flex flex-col bg-canvas p-6" key={tier.name}>
                            <Kicker>{tier.name}</Kicker>
                            <p className="mt-2 text-h3 font-bold text-ink tabular-nums">
                                ${tier.price}
                                <span className="text-blurb font-normal text-ink-faint"> / month</span>
                            </p>
                            <ul className="mt-5 flex flex-col gap-2.5 text-blurb text-ink-muted">
                                {tier.benefits.map((benefit) => (
                                    <li key={benefit}>{benefit}</li>
                                ))}
                            </ul>
                            {tier.callout ? (
                                <Kicker className="mt-auto pt-6" tone="accent">
                                    {tier.callout}
                                </Kicker>
                            ) : null}
                        </div>
                    ))}
                </div>
                <div className="mt-8">
                    <Action href={SPONSOR_URL}>
                        Pick a tier on GitHub
                        <MoveUpRight className="size-4" />
                    </Action>
                </div>
            </Shell>
        </Section>

        <Section id="funds" tone="canvas">
            <Shell>
                <SectionHeader label="What it funds" title="Where the money goes." />
                <ul className="grid grid-cols-1 gap-px bg-hairline sm:grid-cols-2 lg:grid-cols-3">
                    {funds.map((item) => (
                        <li className="bg-canvas p-6 text-body text-ink" key={item}>
                            {item}
                        </li>
                    ))}
                </ul>
            </Shell>
        </Section>

        <Section id="faq" tone="canvas">
            <Shell>
                <SectionHeader label="FAQ" title="Questions." />
                <dl className="grid grid-cols-1 gap-px bg-hairline md:grid-cols-2">
                    {faq.map((item) => (
                        <div className="bg-canvas p-6 sm:p-8" key={item.question}>
                            <dt className="text-h3 font-bold text-ink">{item.question}</dt>
                            <dd className="mt-1.5 text-blurb text-ink-muted">{item.answer}</dd>
                        </div>
                    ))}
                </dl>
            </Shell>
        </Section>

        <Section id="sponsor" tone="canvas">
            <Shell>
                <div className="flex flex-col gap-6 border border-hairline p-8 sm:p-10">
                    <h2 className="text-h2 font-bold text-balance text-ink">Help keep Lunora moving.</h2>
                    <SponsorCta />
                    <p className="text-blurb text-ink-muted">
                        Companies that need an invoice can email{" "}
                        <a className="text-accent underline-offset-4 hover:underline" href={`mailto:${SPONSOR_EMAIL}`}>
                            {SPONSOR_EMAIL}
                        </a>
                        .
                    </p>
                    <div className="flex flex-wrap gap-x-6 gap-y-2 text-blurb text-ink-muted">
                        <a
                            className="inline-flex items-center gap-1 hover:text-ink"
                            href="https://github.com/anolilab/lunora"
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            GitHub <MoveUpRight className="size-3.5" />
                        </a>
                        <a
                            className="inline-flex items-center gap-1 hover:text-ink"
                            href="https://discord.gg/eajEZvk2PG"
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            Discord <MoveUpRight className="size-3.5" />
                        </a>
                    </div>
                </div>
            </Shell>
        </Section>
    </div>
);

export default Sponsors;
