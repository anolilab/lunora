import SiBetterauth from "@icons-pack/react-simple-icons/icons/SiBetterauth.mjs";
import SiCloudflareworkers from "@icons-pack/react-simple-icons/icons/SiCloudflareworkers.mjs";
import SiGithubactions from "@icons-pack/react-simple-icons/icons/SiGithubactions.mjs";
import SiMysql from "@icons-pack/react-simple-icons/icons/SiMysql.mjs";
import SiPostgresql from "@icons-pack/react-simple-icons/icons/SiPostgresql.mjs";
import SiResend from "@icons-pack/react-simple-icons/icons/SiResend.mjs";
import SiStripe from "@icons-pack/react-simple-icons/icons/SiStripe.mjs";
import SiVitest from "@icons-pack/react-simple-icons/icons/SiVitest.mjs";
import { Check, Sparkles, Workflow } from "lucide-react";
import type { ComponentType, FC } from "react";

import { SectionHead } from "@/components/sections/langbase";
import Reveal from "@/components/sections/reveal";
import { cn } from "@/lib/utils";

/**
 * "Batteries included" — a capability grid covering Lunora's opt-in add-on
 * packages (`@lunora/auth`, `@lunora/payment`, `@lunora/mail`, `@lunora/ai`,
 * bindings, jobs, Hyperdrive, testing). Complements the core-feature bento by
 * showing the full-stack surface each package unlocks, with per-card checklists.
 *
 * Glow-accent cards: each card carries an aurora top-rail and a soft violet glow
 * that brighten on hover, with the mark in a violet-tinted tile. Marks render
 * monochrome in the accent (via `currentColor`) so dark brand hexes (Better Auth,
 * Resend) stay legible on the near-black ground and the row reads cohesively.
 */

interface Icon {
    glyph: ComponentType<{ className?: string }>;
    name: string;
}

interface Capability {
    desc: string;
    features: string[];
    icons: Icon[];
    title: string;
}

const capabilities: Capability[] = [
    {
        desc: "A customizable auth system built on Better Auth — D1-backed, or bring your own store.",
        features: ["Email & password", "Social login (OAuth)", "Magic links", "2FA & passkeys", "Organizations & RBAC", "Email verification", "SSO / OIDC"],
        icons: [{ glyph: SiBetterauth, name: "Better Auth" }],
        title: "Auth",
    },
    {
        desc: "Provider-agnostic payments with a Stripe-first adapter and webhook sync — Polar included.",
        features: ["Subscriptions", "Webhook state sync", "Entitlements", "Metered & usage-based", "Idempotency", "Money helpers"],
        icons: [{ glyph: SiStripe, name: "Stripe" }],
        title: "Payments & Billing",
    },
    {
        desc: "Beautiful, TSX-templated transactional email. Integrate Resend, or use your own SMTP.",
        features: ["TSX templates", "Queue-backed sends", "Resend adapter", "Custom SMTP", "Mail-catcher testing"],
        icons: [{ glyph: SiResend, name: "Resend" }],
        title: "Transactional Email",
    },
    {
        desc: "Workers AI on the Vercel AI SDK — provider-agnostic models wired onto every action ctx.",
        features: ["Workers AI models", "Provider-agnostic", "generateText / streamText", "Embeddings", "Typed tool calls"],
        icons: [{ glyph: Sparkles, name: "AI" }],
        title: "AI",
    },
    {
        desc: "Typed Cloudflare binding facades in one install — storage and data plumbing on ctx.",
        features: ["R2 typed buckets & signed URLs", "Workers KV", "Cloudflare Images", "Vectorize", "Analytics Engine"],
        icons: [{ glyph: SiCloudflareworkers, name: "Cloudflare" }],
        title: "Storage & Bindings",
    },
    {
        desc: "Durable background work: cron triggers, delayed jobs, queues, and multi-step workflows.",
        features: ["Cron triggers", "runAfter / runAt", "Durable Workflows", "Typed queues", "Reusable steps"],
        icons: [{ glyph: Workflow, name: "Workflow" }],
        title: "Background Jobs",
    },
    {
        desc: "Bring your own Postgres or MySQL over Cloudflare Hyperdrive — a driver-agnostic ctx.sql.",
        features: ["PostgreSQL & MySQL", "Cloudflare Hyperdrive", "node-postgres / postgres.js", "mysql2", "Connection pooling"],
        icons: [
            { glyph: SiPostgresql, name: "PostgreSQL" },
            { glyph: SiMysql, name: "MySQL" },
        ],
        title: "Bring-your-own DB",
    },
    {
        desc: "Ship with confidence — an in-memory harness, schema advisors, and deterministic seeding.",
        features: ["In-memory test harness", "Vitest", "Schema & query advisors", "Deterministic seeding", "GitHub Actions"],
        icons: [
            { glyph: SiVitest, name: "Vitest" },
            { glyph: SiGithubactions, name: "GitHub Actions" },
        ],
        title: "Testing & Advisors",
    },
];

const Capabilities: FC = () => (
    <section className="border-t border-white/[0.08] bg-[#0e0e11] py-24" data-nav-theme="dark">
        <div className="mx-auto max-w-6xl px-5 lg:px-0">
            <SectionHead
                eyebrow="Batteries included"
                subtitle="Opt-in packages for auth, payments, email, AI, storage, and jobs — typed onto your ctx, deployed to your own Cloudflare account."
                title="Everything a real app needs"
            />
            <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {capabilities.map((cap, index) => (
                    <Reveal className="h-full" delay={(index % 3) * 0.05} key={cap.title}>
                        <div
                            className={cn(
                                "group relative flex h-full flex-col gap-5 overflow-hidden border border-white/[0.08] bg-[#101014] p-6 transition-[background-color,border-color] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-white/[0.16] hover:bg-[#131318]",
                                // On lg the section runs edge-to-edge, so the outer cards' side
                                // borders sit under the page's vertical guide lines — trim them.
                                index % 3 === 0 && "lg:border-l-0",
                                index % 3 === 2 && "lg:border-r-0",
                            )}
                        >
                            {/* aurora top rail — brightens on hover */}
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(256_72%_68%)] to-transparent opacity-40 transition-opacity duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-90"
                            />
                            {/* soft violet glow — fades in on hover */}
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute -top-16 left-1/2 h-48 w-60 -translate-x-1/2 opacity-0 transition-opacity duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-100"
                                style={{ background: "radial-gradient(closest-side, hsl(256 72% 68% / 0.22), transparent 72%)" }}
                            />
                            <div className="relative z-10 flex flex-1 flex-col gap-5">
                                <div className="flex items-center gap-2">
                                    {cap.icons.map(({ glyph: Glyph, name }) => (
                                        <span
                                            className="flex size-10 items-center justify-center border border-[hsl(256_72%_68%)]/30 bg-[hsl(256_72%_68%)]/10 text-[hsl(256_72%_68%)]"
                                            key={name}
                                        >
                                            <Glyph aria-hidden="true" className="size-5" />
                                        </span>
                                    ))}
                                </div>
                                <div>
                                    <h3 className="text-lg font-medium tracking-tight text-white">{cap.title}</h3>
                                    <p className="mt-1.5 text-sm leading-relaxed text-white/50">{cap.desc}</p>
                                </div>
                                <ul className="mt-auto flex flex-col gap-2">
                                    {cap.features.map((feature) => (
                                        <li className="flex items-center gap-2.5 text-sm text-white/65" key={feature}>
                                            <Check aria-hidden="true" className="size-4 shrink-0 text-[hsl(256_72%_68%)]" />
                                            {feature}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </Reveal>
                ))}
            </div>
        </div>
    </section>
);

export default Capabilities;
