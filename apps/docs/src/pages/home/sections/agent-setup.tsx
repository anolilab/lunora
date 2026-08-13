"use client";

import { Check, Copy, MoveRight } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import { Kicker } from "@/kit/layout";
import posthog from "@/lib/posthog";
import { cn } from "@/lib/utils";
import siteConfig from "~/site.config";

/**
 * The agent hand-off, directly under the hero copy.
 *
 * Most people arriving here will not type the first line of this project — they
 * will paste something at an agent. So the one affordance here is a prompt that
 * points the agent at `/agent-setup.md`. The install command lived beside it
 * briefly and was cut: two more boxes made the hero panel taller than the field
 * it sits in, and `Start building` above already covers the manual path.
 *
 * A URL rather than a wall of pasted instructions: the agent fetches it at the
 * moment it is needed, and the content stays correctable after someone has
 * already copied the prompt.
 */

const AGENT_PROMPT = `Get Lunora-ready by following ${siteConfig.brand.url}/agent-setup.md`;

/**
 * One copy-to-clipboard row. The whole row is the button — a 2.5rem strip is a
 * far easier target than the icon alone, which would sit near the 24px floor.
 */
const CopyRow: FC<{
    /** What the row reads as. Defaults to the copied text itself. */
    children?: ReactNode;
    className?: string;
    /** The prominent variant used for the agent prompt. */
    emphasis?: boolean;
    /** Analytics discriminator. */
    event: string;
    value: string;
}> = ({ children, className, emphasis = false, event, value }) => {
    const [copied, setCopied] = useState(false);

    const copy = () => {
        const run = async () => {
            try {
                await navigator.clipboard.writeText(value);
            } catch {
                // Permission denied, or no secure context. Nothing was copied,
                // so neither the check mark nor the event should claim it was.
                return;
            }

            posthog.capture("agent_setup_copied", { location: "home_hero", target: event });
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1500);
        };

        void run();
    };

    return (
        <button
            aria-label={`Copy: ${value}`}
            className={cn(
                "group flex w-full items-center gap-3 border border-hairline px-3.5 py-2.5 text-left transition-colors hover:border-hairline-strong",
                emphasis ? "bg-wash text-body text-ink hover:bg-surface" : "font-mono text-blurb text-ink-muted hover:text-ink",
                className,
            )}
            onClick={copy}
            type="button"
        >
            {emphasis ? null : <span className="shrink-0 text-ink-faint select-none">$</span>}
            <span className="min-w-0 flex-1 truncate">{children ?? value}</span>
            {copied ? (
                <Check className="size-4 shrink-0 text-positive" />
            ) : (
                <Copy className="size-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink-muted" />
            )}
        </button>
    );
};

const AgentSetup: FC = () => (
    <section className="border border-hairline p-4">
        <Kicker size="micro">Make your agent a Lunora expert</Kicker>

        <CopyRow className="mt-3" emphasis event="prompt" value={AGENT_PROMPT}>
            Copy a prompt to get your agent set up
        </CopyRow>

        {/* Links to the raw file on purpose: anyone handing this to an agent
            should be able to read what it will be told. */}
        <a
            className="group mt-2.5 inline-flex min-h-[24px] items-center gap-1.5 py-0.5 text-blurb text-ink-faint transition-colors hover:text-ink-muted"
            href="/agent-setup.md"
        >
            Works with any model, any agent, any editor
            <MoveRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
    </section>
);

export default AgentSetup;
