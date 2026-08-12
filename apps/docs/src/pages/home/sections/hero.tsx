"use client";

import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, Copy, MoveRight } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import schemaImg from "@/assets/studio/dark/schema.png";
import stats from "@/data/stats.json";
import { RuleGrid } from "@/kit/grid";
import { Kicker, Shell } from "@/kit/layout";
import { SplitHeader } from "@/kit/split-header";
import posthog from "@/lib/posthog";
import PlatformStrip from "@/pages/home/sections/platform-strip";
import siteConfig from "~/site.config";

/**
 * Landing hero: the message and its calls to action on the left, Studio running
 * off the right edge, then the numbered promise row.
 *
 * The visual is the schema browser rather than a dashboard. The headline is
 * about defining a schema, so a capture that answers the sentence beside it
 * argues for the product; a generic dashboard would only say "this has a UI".
 */

const InstallCommand: FC = () => {
    const [copied, setCopied] = useState(false);

    const copy = () => {
        const run = async () => {
            try {
                await navigator.clipboard.writeText(siteConfig.cta.install);
            } catch {
                // Permission denied, or no secure context. Nothing was copied,
                // so neither the check mark nor the event should claim it was.
                return;
            }

            posthog.capture("install_command_copied", { location: "home_hero" });
            setCopied(true);
            setTimeout(() => {
                setCopied(false);
            }, 1500);
        };

        void run();
    };

    return (
        <button
            className="group flex w-full items-center gap-3 border border-hairline px-4 py-3 font-mono text-blurb text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
            onClick={copy}
            type="button"
        >
            <span className="text-ink-faint select-none">$</span>
            {siteConfig.cta.install}
            {copied ? (
                <Check className="ml-auto size-4 text-positive" />
            ) : (
                <Copy className="ml-auto size-3.5 text-ink-faint transition-colors group-hover:text-ink-muted" />
            )}
        </button>
    );
};

const PROMISES = [
    { label: "Open source", text: "FSL-1.1-Apache-2.0, deployed to your own Cloudflare account." },
    { label: "Realtime", text: "Every query is a subscription; mutations push to all clients." },
    { label: "Typed end to end", text: "Codegen keeps server and client in lockstep, or it stops compiling." },
    { label: "Edge native", text: "SQLite-backed Durable Objects, shardable by user, tenant, or room." },
    { label: "Vite first", text: "One dev server for the frontend, the backend, and the studio." },
];

const Hero: FC = () => (
    <>
        <p className="sr-only">
            Lunora is a type-safe, real-time backend framework on Cloudflare Workers and Durable Objects with a Vite-first developer experience. Define a schema
            and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live subscriptions, optimistic updates,
            and an offline queue — types sync from server to client automatically via codegen.
        </p>

        <SplitHeader
            visual={
                // Anchored left and oversized so the capture keeps its own scale
                // and simply continues past the viewport, rather than being
                // shrunk to fit and becoming unreadable.
                <img
                    alt="Lunora Studio, browsing the schema of a live edge database"
                    className="absolute inset-y-0 left-0 h-full max-w-none object-cover object-left-top lg:w-[64rem]"
                    fetchPriority="high"
                    height={1252}
                    src={schemaImg}
                    width={2048}
                />
            }
        >
            <div className="max-w-[34rem]">
                <span className="inline-flex items-center gap-2.5 border border-hairline px-3 py-1.5">
                    <span className="size-1.5 bg-accent" />
                    <Kicker size="micro" tone="muted">
                        Alpha · FSL-1.1-Apache-2.0
                    </Kicker>
                </span>

                <h1 className="mt-7 text-display font-bold text-balance text-ink">
                    Realtime backends,
                    <br />
                    <span className="text-accent">in a few lines of code.</span>
                </h1>

                <p className="mt-5 text-body text-ink-muted">
                    Define a schema, write a function — Lunora gives you a typed, live-syncing API on Cloudflare&apos;s edge. No glue code, no infrastructure to
                    manage.
                </p>

                {/* Two cells of one bordered row rather than two loose buttons:
                    the pair reads as a single control strip and lines up with
                    the install field beneath it. */}
                <div className="mt-8 grid grid-cols-1 border border-hairline sm:grid-cols-2">
                    <Link
                        className="group flex items-center justify-between gap-3 bg-emphasis px-5 py-4 font-mono text-kicker text-on-emphasis uppercase transition-opacity hover:opacity-90"
                        to={siteConfig.cta.primary.to}
                    >
                        {siteConfig.cta.primary.label}
                        <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                    <a
                        className="group flex items-center justify-between gap-3 border-t border-hairline px-5 py-4 font-mono text-kicker text-ink uppercase transition-colors hover:bg-hairline sm:border-t-0 sm:border-l"
                        href={siteConfig.cta.secondary.href}
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        {siteConfig.cta.secondary.label}
                        <MoveRight className="size-4 text-ink-faint transition-transform group-hover:translate-x-0.5" />
                    </a>
                </div>

                <div className="mt-3">
                    <InstallCommand />
                </div>

                {/* Real repository figures instead of a row of stock faces. There
                    are no customer logos to show, and inventing them would be
                    the cheapest thing on the page. */}
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-hairline pt-6">
                    <Kicker size="micro">{stats.stars} stars</Kicker>
                    <Kicker size="micro">{stats.contributors} contributors</Kicker>
                    <Kicker size="micro">{Object.keys(stats.weeklyDownloads).length} packages</Kicker>
                    <Kicker size="micro">React · Vue · Svelte · Solid</Kicker>
                </div>
            </div>
        </SplitHeader>

        <PlatformStrip />

        <Shell>
            <RuleGrid items={PROMISES} />
        </Shell>
    </>
);

export default Hero;
