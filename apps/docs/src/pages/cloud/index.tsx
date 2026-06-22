"use client";

import { ArrowRight, BarChart3, Check, LayoutDashboard, LifeBuoy, RotateCcw } from "lucide-react";
import type { FC, FormEvent, ReactNode } from "react";
import { useState } from "react";

import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";

/**
 * Lunora Cloud landing — the managed tier (still in progress), behind an
 * early-access waitlist. Holds the brand wedge: self-host on your own Cloudflare
 * account, or let Lunora Cloud run it. Same code, no lock-in. Shared dark frame.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "error" | "idle" | "sending" | "success";

const WaitlistForm: FC = () => {
    const [email, setEmail] = useState("");
    const [status, setStatus] = useState<Status>("idle");

    const submit = async (event: FormEvent) => {
        event.preventDefault();

        if (!EMAIL_RE.test(email)) {
            setStatus("error");

            return;
        }

        setStatus("sending");

        try {
            const response = await fetch("/api/waitlist", {
                body: JSON.stringify({ email, source: "cloud" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });

            setStatus(response.ok ? "success" : "error");
        } catch {
            setStatus("error");
        }
    };

    if (status === "success") {
        return (
            <div className="flex w-full max-w-md items-center gap-3 border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-200">
                <Check className="size-4 shrink-0" />
                You&apos;re on the list. We&apos;ll send one email when Lunora Cloud opens.
            </div>
        );
    }

    return (
        <form className="flex w-full max-w-md flex-col gap-2" onSubmit={submit}>
            <div className="flex flex-col gap-2 sm:flex-row">
                <input
                    aria-label="Email address"
                    autoComplete="email"
                    className="h-11 flex-1 border border-white/15 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none"
                    inputMode="email"
                    onChange={(event) => {
                        setEmail(event.target.value);

                        if (status === "error") {
                            setStatus("idle");
                        }
                    }}
                    placeholder="you@company.com"
                    type="email"
                    value={email}
                />
                <button
                    className="inline-flex h-11 items-center justify-center gap-2 bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-60"
                    disabled={status === "sending"}
                    type="submit"
                >
                    {status === "sending" ? "Joining…" : "Get early access"}
                    <ArrowRight className="size-4" />
                </button>
            </div>
            <p className="text-xs text-white/40">
                {status === "error"
                    ? "Please enter a valid email address."
                    : "One email when Cloud opens. No spam. You can self-host the same project any time."}
            </p>
        </form>
    );
};

interface Perk {
    desc: string;
    icon: ReactNode;
    title: string;
}

const perks: Perk[] = [
    { desc: "The admin UI, hosted and always on — schema, data, SQL, logs.", icon: <LayoutDashboard className="size-5" />, title: "Managed Studio" },
    { desc: "Metrics, traces, and request logs across your shards, in one place.", icon: <BarChart3 className="size-5" />, title: "Observability" },
    { desc: "Automatic backups and point-in-time restore across every shard.", icon: <RotateCcw className="size-5" />, title: "Backups & restore" },
    { desc: "A human on support when something breaks. Priority for teams.", icon: <LifeBuoy className="size-5" />, title: "Real support" },
];

const CloudLanding: FC = () => (
    <>
        {/* Hero + waitlist */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-80 opacity-60"
                style={{ background: "radial-gradient(60% 100% at 50% 0%, hsl(256 72% 68% / 0.18), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-40 pb-20 text-center sm:pt-48">
                <Reveal className="flex flex-col items-center gap-6">
                    <span className="flex items-center gap-2 border border-white/12 px-3 py-1 font-mono text-xs text-white/60">
                        <span className="size-1.5 bg-royal-amethyst" />
                        Lunora Cloud · coming soon
                    </span>
                    <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-white sm:text-6xl">
                        The managed way to run{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">Lunora.</span>
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-white/55">
                        Lunora is open source and runs on your own Cloudflare account today. Lunora Cloud will run it for you, so you can ship instead of
                        operate infrastructure.
                    </p>
                    <WaitlistForm />
                    <p className="text-sm text-white/45">
                        Want it now?{" "}
                        <Pill to="/docs/$">
                            Self-host the open-source framework
                            <ArrowRight className="size-4" />
                        </Pill>
                    </p>
                </Reveal>
            </div>
        </section>

        {/* No lock-in: own it or let us run it */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-px border-white/[0.08] md:grid-cols-2 md:border-x">
                <div className="flex flex-col gap-3 border-b border-white/[0.08] p-8 md:border-r md:border-b-0">
                    <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Own it</span>
                    <h3 className="text-xl font-semibold text-white">Self-host on your Cloudflare</h3>
                    <p className="text-sm leading-relaxed text-white/55">
                        The framework is free and open source. Deploy to the Cloudflare account you already have. Your data, your infrastructure, ≈$0 at idle on
                        the free tier.
                    </p>
                </div>
                <div className="flex flex-col gap-3 p-8">
                    <span className="font-mono text-xs tracking-wider text-white/40 uppercase">Or let us run it</span>
                    <h3 className="text-xl font-semibold text-white">Lunora Cloud</h3>
                    <p className="text-sm leading-relaxed text-white/55">
                        The same code, managed for you. No setup, no ops. You&apos;re never forced onto the cloud — you can take the open source and self-host
                        any time. No lock-in, ever.
                    </p>
                </div>
            </div>
        </section>

        {/* What you get */}
        <section className="relative border-t border-white/[0.08] bg-[#0e0e11] py-16" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-5 sm:grid-cols-2 lg:grid-cols-4">
                {perks.map((perk) => (
                    <div className="flex flex-col gap-3" key={perk.title}>
                        <span className="flex size-10 items-center justify-center border border-white/10 bg-white/[0.04] text-white/80">{perk.icon}</span>
                        <h4 className="text-sm font-semibold text-white">{perk.title}</h4>
                        <p className="text-sm leading-relaxed text-white/50">{perk.desc}</p>
                    </div>
                ))}
            </div>
        </section>

        {/* Closing waitlist nudge */}
        <section className="relative overflow-hidden border-t border-white/[0.08] bg-[#0e0e11]" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-64 opacity-50"
                style={{ background: "radial-gradient(60% 100% at 50% 120%, hsl(256 72% 68% / 0.22), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-20 text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Be first on Lunora Cloud.</h2>
                <p className="max-w-lg text-white/55">
                    It&apos;s early. Join the waitlist and help shape the first managed tier — we&apos;ll ask what you&apos;d want it to do.
                </p>
                <WaitlistForm />
            </div>
        </section>
    </>
);

export default CloudLanding;
