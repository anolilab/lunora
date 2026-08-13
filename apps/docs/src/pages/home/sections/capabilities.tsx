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

import { GridCell, HairlineGrid } from "@/kit/grid";
import { Section, SectionHeader, Shell } from "@/kit/layout";

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
    <Section id="capabilities">
        <Shell>
            <SectionHeader label="Add-ons" note="Deployed to your own Cloudflare account." title="Everything a real app needs">
                <p className="text-body text-ink-muted">Opt-in packages for auth, payments, email, AI, storage, and jobs — typed onto your ctx.</p>
            </SectionHeader>

            {/* No per-cell `Reveal` wrapper here: a transparent wrapper would
                become the grid item and let the container's hairline show
                through the whole cell face instead of only at the seams. */}
            <HairlineGrid className="border border-hairline lg:border-x-0" columns={4}>
                {capabilities.map((cap) => (
                    <GridCell
                        blurb={cap.desc}
                        icon={cap.icons.map(({ glyph: Glyph, name }) => (
                            <Glyph aria-hidden="true" key={name} />
                        ))}
                        key={cap.title}
                        title={cap.title}
                    >
                        <ul className="flex flex-col gap-2">
                            {cap.features.map((feature) => (
                                <li className="flex items-center gap-2.5 text-blurb text-ink-muted" key={feature}>
                                    <Check aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
                                    {feature}
                                </li>
                            ))}
                        </ul>
                    </GridCell>
                ))}
            </HairlineGrid>
        </Shell>
    </Section>
);

export default Capabilities;
