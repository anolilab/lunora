"use client";

import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import type { FC, SyntheticEvent } from "react";
import { useId, useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Action } from "@/kit/action";
import { Kicker, Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import posthog from "@/lib/posthog";

/**
 * Lunora Cloud landing — the managed tier (still in progress), behind an
 * early-access waitlist. Holds the brand wedge: self-host on your own Cloudflare
 * account, or let Lunora Cloud run it. Same code, no lock-in. Shared dark frame.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

type Status = "error" | "idle" | "sending" | "success";

const WaitlistForm: FC<{ source?: string }> = ({ source = "cloud" }) => {
    const instance = useId();
    const consentId = `privacy-consent-${instance}`;
    const honeyId = `honey-${instance}`;
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
                <label htmlFor={honeyId}>
                    Don&apos;t fill this out if you&apos;re human: <input id={honeyId} name="honeyField" tabIndex={-1} />
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
            <label className="flex items-start gap-2 text-left text-xs leading-relaxed text-ink-muted" htmlFor={consentId}>
                <input
                    checked={consent}
                    className="mt-0.5 size-4 shrink-0 accent-accent-2"
                    id={consentId}
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

/**
 * What the control plane actually does, taken from the platform's own modules
 * rather than invented for the page. Every line here maps to something built:
 * deploy orchestration, the Workers-for-Platforms dispatcher, org membership and
 * deploy keys, tenant secrets, Analytics-Engine metering with quota enforcement,
 * the hosted studio, custom domains, and the cron/queue fan-out that namespaced
 * Workers cannot do for themselves.
 *
 * It is written as what is being built, because none of it has opened to the
 * public yet — a waitlist page that claims shipped features is the one thing
 * this page cannot do.
 */
const capabilities: { body: string; kicker: string; title: string }[] = [
    {
        body: "Push and watch it go out: deploy status streams back line by line, pull requests get their own preview URL, and any deployment can be rolled back.",
        kicker: "Deploys",
        title: "Streaming deploys and previews",
    },
    {
        body: "Your project runs as its own script behind a hostname router, with runtime limits applied per plan instead of shared with everyone else's traffic.",
        kicker: "Isolation",
        title: "A worker per project",
    },
    {
        body: "Organisations with members, invitations and roles; deploy keys for CI; and an audit log of who changed what.",
        kicker: "Teams",
        title: "Orgs, keys, and an audit trail",
    },
    {
        body: "Per-tenant secrets, encrypted at the edge and injected at deploy time — never checked into a repo, never readable from the dashboard.",
        kicker: "Secrets",
        title: "Secrets that stay secret",
    },
    {
        body: "Requests, duration and storage metered per tenant, with quotas and a spend cap that stops the bill before it surprises you.",
        kicker: "Usage",
        title: "Metering and spend caps",
    },
    {
        body: "The Studio you run locally, hosted and always on: schema, data, SQL, request logs and traces across every shard.",
        kicker: "Studio",
        title: "Managed Studio",
    },
    {
        body: "Point a domain at a project and the platform verifies DNS and takes over routing — no certificate wrangling.",
        kicker: "Domains",
        title: "Custom domains",
    },
    {
        body: "Scheduled functions and queue consumers work the same as they do on your own account, fanned out to your worker by the platform.",
        kicker: "Background",
        title: "Cron and queues",
    },
];

const CloudLanding: FC = () => (
    <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
        <ArticleHeader
            actions={
                <Action to="/docs">
                    Self-host it today
                    <ArrowRight className="size-4" />
                </Action>
            }
            breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Cloud" }]}
            lead="Lunora is open source and runs on your own Cloudflare account today. Lunora Cloud will run it for you, so you can ship instead of operate infrastructure."
            meta="Early access"
            title="The managed way to run Lunora."
        />

        <section data-nav-theme="dark">
            <Shell className="flex flex-col items-center gap-4 py-14 text-center">
                <WaitlistForm />
            </Shell>
        </section>

        <HatchSpacer />

        {/* The brand wedge, and the reason the waitlist is not a lock-in ask. */}
        <section data-nav-theme="dark">
            <Shell className="py-16">
                <div className="grid grid-cols-1 gap-px bg-hairline md:grid-cols-2">
                    <div className="flex flex-col gap-3 bg-canvas p-8">
                        <Kicker size="micro">Own it</Kicker>
                        <h3 className="text-h3 font-semibold text-ink">Self-host on your Cloudflare</h3>
                        <p className="text-sm leading-relaxed text-ink-muted">
                            The framework is free and open source. Deploy to the Cloudflare account you already have. Your data, your infrastructure, &asymp;$0
                            at idle on the free tier.
                        </p>
                    </div>
                    <div className="flex flex-col gap-3 bg-canvas p-8">
                        <Kicker size="micro" tone="accent">
                            Or let us run it
                        </Kicker>
                        <h3 className="text-h3 font-semibold text-ink">Lunora Cloud</h3>
                        <p className="text-sm leading-relaxed text-ink-muted">
                            The same code, managed for you. No setup, no ops. You&apos;re never forced onto the cloud — you can take the open source and
                            self-host any time. No lock-in, ever.
                        </p>
                    </div>
                </div>
            </Shell>
        </section>

        <HatchSpacer />

        <section data-nav-theme="dark">
            <Shell className="py-16">
                <div className="mb-10 flex flex-col gap-3">
                    <Kicker size="micro">What is being built</Kicker>
                    <h2 className="max-w-2xl text-h2 font-semibold tracking-tight text-ink">A control plane, not a hosting reseller.</h2>
                    <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
                        Lunora Cloud runs on Workers for Platforms: each project gets its own isolated worker, provisioned, metered and routed by a control
                        plane built on Lunora itself.
                    </p>
                </div>

                <div className="grid grid-cols-1 gap-px bg-hairline sm:grid-cols-2 lg:grid-cols-4">
                    {capabilities.map((item) => (
                        <div className="flex flex-col gap-2.5 bg-canvas p-6" key={item.title}>
                            <Kicker size="micro">{item.kicker}</Kicker>
                            <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                            <p className="text-sm leading-relaxed text-ink-muted">{item.body}</p>
                        </div>
                    ))}
                </div>
            </Shell>
        </section>

        <HatchSpacer />

        <section data-nav-theme="dark">
            <Shell className="flex flex-col items-center gap-6 py-20 text-center">
                <h2 className="text-h2 font-semibold tracking-tight text-ink">Be first on Lunora Cloud.</h2>
                <p className="max-w-lg text-body text-ink-muted">
                    It&apos;s early. Join the waitlist and help shape the first managed tier — we&apos;ll ask what you&apos;d want it to do.
                </p>
                <WaitlistForm />
            </Shell>
        </section>
    </div>
);

export default CloudLanding;
