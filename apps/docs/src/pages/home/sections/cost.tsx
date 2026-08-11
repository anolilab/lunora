import { ArrowUpRight } from "lucide-react";
import type { FC } from "react";

import { Kicker, Section, SectionHeader, Shell } from "@/kit/layout";

/**
 * What it costs.
 *
 * Cost is the first question a team asks about infrastructure, and the answer
 * here is structural rather than numeric: there is no Lunora bill, because
 * Lunora is a framework you deploy to an account you already own.
 *
 * Deliberately quotes no dollar figures. Cloudflare's rates change and are not
 * ours to restate; inventing a price table here would be exactly the kind of
 * fake precision that stops being true a quarter later. The reader gets the
 * shape of the bill and a link to the authority for the numbers.
 */

const FACTS = [
    {
        body: "The framework is free and open source under FSL-1.1-Apache-2.0. There is no seat, no project limit, and no usage tier to graduate out of.",
        label: "No Lunora bill",
    },
    {
        body: "You deploy to your own Cloudflare account and pay Cloudflare directly, at their published rates. No middleman margin, and no egress charge on the way out.",
        label: "You pay Cloudflare",
    },
    {
        body: "Durable Objects idle at roughly nothing, and nothing forces a project to pause. A side project that nobody visits this month costs about what it did last month.",
        label: "Roughly zero at idle",
    },
];

const Cost: FC = () => (
    <Section id="cost" tone="deep">
        <Shell>
            <SectionHeader index="04" label="Cost" title="There is no bill from us.">
                <p className="text-body text-ink-muted">
                    Lunora is a framework, not a hosting company. It runs on infrastructure you already own, which changes what you are agreeing to when you
                    adopt it.
                </p>
            </SectionHeader>

            <dl className="grid grid-cols-1 gap-x-col-gap gap-y-10 md:grid-cols-3">
                {FACTS.map((fact) => (
                    <div className="flex flex-col gap-3 border-t border-hairline pt-5" key={fact.label}>
                        <dt>
                            <Kicker tone="accent">{fact.label}</Kicker>
                        </dt>
                        <dd className="text-body text-ink-muted">{fact.body}</dd>
                    </div>
                ))}
            </dl>

            <p className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2">
                <a
                    className="group inline-flex items-center gap-2 text-blurb text-ink-muted transition-colors hover:text-ink"
                    href="https://developers.cloudflare.com/workers/platform/pricing/"
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    Cloudflare Workers pricing
                    <ArrowUpRight className="size-3.5 text-ink-faint transition-colors group-hover:text-accent" />
                </a>
                <a
                    className="group inline-flex items-center gap-2 text-blurb text-ink-muted transition-colors hover:text-ink"
                    href="https://developers.cloudflare.com/durable-objects/platform/pricing/"
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    Durable Objects pricing
                    <ArrowUpRight className="size-3.5 text-ink-faint transition-colors group-hover:text-accent" />
                </a>
            </p>
        </Shell>
    </Section>
);

export default Cost;
