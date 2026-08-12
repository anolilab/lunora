"use client";

import { Check, ChevronRight, Copy } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { Action } from "@/kit/action";
import { RuleGrid } from "@/kit/grid";
import { Kicker, Shell } from "@/kit/layout";
import { PageHeader } from "@/kit/page-header";
import posthog from "@/lib/posthog";
import siteConfig from "~/site.config";

/**
 * Landing hero: the colour field and its panel, then the numbered promise row
 * that states what Lunora is before any section argues for it.
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
            className="group flex w-full items-center gap-3 border border-hairline px-4 py-2.5 font-mono text-blurb text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
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

        <PageHeader>
            <div className="mb-5 flex items-center justify-between gap-4">
                <Kicker>Open source / FSL-1.1-Apache-2.0</Kicker>
                <Kicker>Alpha</Kicker>
            </div>

            <h1 className="text-h1 font-bold text-ink">
                <span className="text-accent">{siteConfig.brand.name}.</span>
                <br />
                Realtime backends, in a few lines of code.
            </h1>

            <p className="mt-4 text-body text-ink-muted">
                Define a schema, write a function — Lunora gives you a typed, live-syncing API on Cloudflare&apos;s edge. No glue code, no infrastructure to
                manage.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Action to={siteConfig.cta.primary.to} variant="primary">
                    {siteConfig.cta.primary.label}
                    <ChevronRight className="size-4" />
                </Action>
                <Action href={siteConfig.cta.secondary.href}>{siteConfig.cta.secondary.label}</Action>
            </div>

            <p className="mt-5">
                <Kicker size="micro">Available for React · Vue · Svelte · Solid</Kicker>
            </p>

            <div className="mt-3">
                <InstallCommand />
            </div>
        </PageHeader>

        <Shell className="mt-[clamp(2.5rem,1.5rem+4vw,5rem)]">
            <RuleGrid items={PROMISES} />
        </Shell>
    </>
);

export default Hero;
