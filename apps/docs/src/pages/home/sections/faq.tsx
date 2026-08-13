import { Plus } from "lucide-react";
import type { FC } from "react";

import { Section, SectionHeader, Shell } from "@/kit/layout";

/**
 * The objections a technical evaluator actually has, answered without spin.
 *
 * Built on native `<details>`/`<summary>`: it is keyboard accessible, works
 * without JavaScript, is findable by in-page search when open, and needs no
 * state. A JS accordion here would be strictly worse in every one of those.
 *
 * The alpha answer leads because it is the real objection. Burying it would
 * cost more trust than admitting it.
 */

const FAQS = [
    {
        a: "No. Lunora is alpha and the API still breaks between releases. Every package is published under a 1.0.0-alpha version and pre-release branches drop old code paths rather than keeping shims. Build side projects and internal tools on it today; wait for 1.0 before it carries revenue.",
        q: "Is Lunora production-ready?",
    },
    {
        a: "Your own Cloudflare account. Lunora deploys as Workers and Durable Objects that you own, so your data sits in your account and your bill comes from Cloudflare. There is no Lunora-operated cloud to migrate off, because there is no Lunora-operated cloud.",
        q: "Where does my data live?",
    },
    {
        a: "Yes, and self-hosting is the only mode. It is not a degraded tier of a paid product. The framework is FSL-1.1-Apache-2.0: source-available now, and each release converts to Apache-2.0 on a fixed schedule.",
        q: "Can I self-host it?",
    },
    {
        a: "State lives in SQLite-backed Durable Objects at the edge. A single Durable Object per app is the default and is enough for most projects; you opt into sharding by user, tenant, or room when you need it, and into global replication for low-latency reads.",
        q: "What is the data model?",
    },
    {
        a: "React, Vue, Svelte, Solid, Astro, TanStack, Nuxt, and Analog have live adapters, plus React Native and Expo. The client is framework-agnostic underneath, so a framework without an adapter still works, just without the framework-specific hooks.",
        q: "Which frontends are supported?",
    },
    {
        a: "Self-hosted, you pay Cloudflare directly at their published rates and nothing else. Durable Objects idle at roughly nothing and nothing forces a project to pause, so an unvisited project costs about what it did last month.",
        q: "What does it cost to run?",
    },
];

const Faq: FC = () => (
    <Section id="faq" tone="deep">
        <Shell>
            <SectionHeader label="Questions" title="Answered plainly.">
                <p className="text-body text-ink-muted">Including the ones with awkward answers.</p>
            </SectionHeader>

            <div className="border-t border-hairline">
                {FAQS.map((faq) => (
                    <details className="group border-b border-hairline" key={faq.q} name="lunora-faq">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-body text-ink transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
                            {faq.q}
                            <Plus
                                aria-hidden="true"
                                className="size-4 shrink-0 text-ink-faint transition-transform duration-200 group-open:rotate-45 group-hover:text-accent"
                            />
                        </summary>
                        <p className="max-w-[65ch] pb-6 text-blurb text-ink-muted">{faq.a}</p>
                    </details>
                ))}
            </div>
        </Shell>
    </Section>
);

export default Faq;
