"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, BarChart3, Check, LayoutDashboard, LifeBuoy, RotateCcw } from "lucide-react";
import type { FC, ReactNode, SyntheticEvent } from "react";
import { useState } from "react";

import { Pill } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import posthog from "@/lib/posthog";

/**
 * Lunora Cloud landing — the managed tier (still in progress), behind an
 * early-access waitlist. Holds the brand wedge: self-host on your own Cloudflare
 * account, or let Lunora Cloud run it. Same code, no lock-in. Shared dark frame.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

type Status = "error" | "idle" | "sending" | "success";

const WaitlistForm: FC<{ source?: string }> = ({ source = "cloud" }) => {
    const [email, setEmail] = useState("");
    const [consent, setConsent] = useState(false);
    const [status, setStatus] = useState<Status>("idle");
    const [errorMessage, setErrorMessage] = useState("");

    const fail = (message: string) => {
        setErrorMessage(message);
        setStatus("error");
    };

    const submit = async (event: SyntheticEvent) => {
        event.preventDefault();

        if (!EMAIL_RE.test(email)) {
            fail("Please enter a valid email address.");

            return;
        }

        // GDPR: explicit, opt-in consent is required before we store the email.
        if (!consent) {
            fail("Please agree to the privacy policy.");

            return;
        }

        setStatus("sending");

        try {
            // Netlify Forms: POST url-encoded to the static detection form (public/__forms.html).
            const response = await fetch("/__forms.html", {
                body: new URLSearchParams({ email, "form-name": "lunora-waitlist", honeyField: "", privacy: "true", source }).toString(),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                method: "POST",
            });

            if (response.ok) {
                posthog.capture("waitlist_joined", { source });
                setStatus("success");
            } else {
                fail("Something went wrong. Please try again.");
            }
        } catch {
            fail("Something went wrong. Please try again.");
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
        <form
            className="flex w-full max-w-md flex-col gap-2"
            data-netlify="true"
            method="POST"
            name="lunora-waitlist"
            // eslint-disable-next-line react/no-unknown-property -- Netlify Forms spam-filter attribute, read by Netlify's build, not the DOM
            netlify-honeypot="honeyField"
            onSubmit={(event) => void submit(event)}
        >
            <input name="form-name" type="hidden" value="lunora-waitlist" />
            <input name="source" type="hidden" value={source} />
            <p className="hidden">
                <label htmlFor="honeyField">
                    Don&apos;t fill this out if you&apos;re human: <input id="honeyField" name="honeyField" tabIndex={-1} />
                </label>
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
                <input
                    aria-label="Email address"
                    autoComplete="email"
                    className="h-11 flex-1 border border-hairline-strong bg-wash px-4 text-sm text-ink placeholder:text-ink-faint focus:border-hairline-strong focus:outline-none"
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
                    className="inline-flex h-11 items-center justify-center gap-2 bg-panel px-5 text-sm font-medium text-on-panel transition-colors hover:bg-panel disabled:opacity-60"
                    disabled={status === "sending"}
                    type="submit"
                >
                    {status === "sending" ? "Joining…" : "Get early access"}
                    <ArrowRight className="size-4" />
                </button>
            </div>
            <label className="flex items-start gap-2 text-left text-xs leading-relaxed text-ink-muted" htmlFor="privacy-consent">
                <input
                    checked={consent}
                    className="mt-0.5 size-4 shrink-0 accent-accent-2"
                    id="privacy-consent"
                    name="privacy"
                    onChange={(event) => {
                        setConsent(event.target.checked);

                        if (status === "error") {
                            setStatus("idle");
                        }
                    }}
                    required
                    type="checkbox"
                    value="true"
                />
                <span>
                    I agree to the{" "}
                    <Link className="text-ink-muted underline decoration-white/25 underline-offset-2 hover:text-ink" to="/privacy">
                        Privacy Policy
                    </Link>{" "}
                    and to receiving one email when Lunora Cloud opens. No spam; unsubscribe any time.
                </span>
            </label>
            <p className={`text-xs ${status === "error" ? "text-red-400" : "text-ink-faint"}`}>
                {status === "error" ? errorMessage : "Your email is only used to notify you. You can self-host the open-source framework any time."}
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
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        {/* vertical guide lines at the container edges, full page height */}
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-hairline lg:block"
        />
        {/* Hero + waitlist */}
        <section className="relative border-t border-hairline bg-canvas" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-80 opacity-60"
                style={{ background: "radial-gradient(60% 100% at 50% 0%, hsl(256 72% 68% / 0.18), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 pt-40 pb-20 text-center sm:pt-48">
                <Reveal className="flex flex-col items-center gap-6">
                    <span className="flex items-center gap-2 border border-hairline px-3 py-1 font-mono text-xs text-ink-muted">
                        <span className="size-1.5 bg-royal-amethyst" />
                        Lunora Cloud · coming soon
                    </span>
                    <h1 className="text-5xl leading-[1.04] font-semibold tracking-tight text-balance text-ink sm:text-6xl">
                        The managed way to run{" "}
                        <span className="bg-gradient-to-r from-sky-sapphire via-royal-amethyst to-crimson-energy bg-clip-text text-transparent">Lunora.</span>
                    </h1>
                    <p className="max-w-xl text-lg leading-relaxed text-ink-muted">
                        Lunora is open source and runs on your own Cloudflare account today. Lunora Cloud will run it for you, so you can ship instead of
                        operate infrastructure.
                    </p>
                    <WaitlistForm />
                    <p className="text-sm text-ink-faint">
                        Want it now?{" "}
                        <Pill to="/docs">
                            Self-host the open-source framework
                            <ArrowRight className="size-4" />
                        </Pill>
                    </p>
                </Reveal>
            </div>
        </section>

        {/* No lock-in: own it or let us run it */}
        <section className="relative border-t border-hairline bg-canvas" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-px border-hairline md:grid-cols-2 md:border-x">
                <div className="flex flex-col gap-3 border-b border-hairline p-8 md:border-r md:border-b-0">
                    <span className="font-mono text-xs tracking-wider text-ink-faint uppercase">Own it</span>
                    <h3 className="text-xl font-semibold text-ink">Self-host on your Cloudflare</h3>
                    <p className="text-sm leading-relaxed text-ink-muted">
                        The framework is free and open source. Deploy to the Cloudflare account you already have. Your data, your infrastructure, ≈$0 at idle on
                        the free tier.
                    </p>
                </div>
                <div className="flex flex-col gap-3 p-8">
                    <span className="font-mono text-xs tracking-wider text-ink-faint uppercase">Or let us run it</span>
                    <h3 className="text-xl font-semibold text-ink">Lunora Cloud</h3>
                    <p className="text-sm leading-relaxed text-ink-muted">
                        The same code, managed for you. No setup, no ops. You&apos;re never forced onto the cloud — you can take the open source and self-host
                        any time. No lock-in, ever.
                    </p>
                </div>
            </div>
        </section>

        {/* What you get */}
        <section className="relative border-t border-hairline bg-canvas py-16" data-nav-theme="dark">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-5 sm:grid-cols-2 lg:grid-cols-4">
                {perks.map((perk) => (
                    <div className="flex flex-col gap-3" key={perk.title}>
                        <span className="flex size-10 items-center justify-center border border-hairline bg-wash text-ink-muted">{perk.icon}</span>
                        <h4 className="text-sm font-semibold text-ink">{perk.title}</h4>
                        <p className="text-sm leading-relaxed text-ink-muted">{perk.desc}</p>
                    </div>
                ))}
            </div>
        </section>

        {/* Closing waitlist nudge */}
        <section className="relative overflow-hidden border-t border-hairline bg-canvas" data-nav-theme="dark">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 -z-0 h-64 opacity-50"
                style={{ background: "radial-gradient(60% 100% at 50% 120%, hsl(256 72% 68% / 0.22), transparent 70%)" }}
            />
            <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-20 text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Be first on Lunora Cloud.</h2>
                <p className="max-w-lg text-ink-muted">
                    It&apos;s early. Join the waitlist and help shape the first managed tier — we&apos;ll ask what you&apos;d want it to do.
                </p>
                <WaitlistForm />
            </div>
        </section>
    </div>
);

export default CloudLanding;
