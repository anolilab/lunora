/**
 * Content for /sponsors. The tiers mirror the GitHub Sponsors listing for
 * `prisis` exactly — change them there first, then here, so the page never
 * promises a perk the checkout does not sell.
 */

export const SPONSOR_URL = "https://github.com/sponsors/prisis";
export const SPONSOR_EMAIL = "hello@anolilab.com";

export interface Tier {
    benefits: string[];
    /** Short accent label under the perks, for the one tier the page steers readers to. */
    callout?: string;
    name: string;
    /** Monthly price in USD. */
    price: number;
}

export const tiers: Tier[] = [
    { benefits: ["A sponsor badge on your GitHub profile"], name: "Supporter", price: 1 },
    { benefits: ["Everything above", "A coffee on me the next time we meet"], name: "Coffee", price: 5 },
    { benefits: ["Everything above", "Your name in the “Supporter” section of anolilab.com/thanks"], name: "Backer", price: 10 },
    {
        benefits: ["Everything above", "Your name and logo in the “Top Supporter” section of anolilab.com/thanks"],
        callout: "Companies start here",
        name: "Top supporter",
        price: 25,
    },
    {
        benefits: ["Everything above", "Priority GitHub issues: yours get read first", "A thank-you post on X"],
        name: "Partner",
        price: 75,
    },
];

export interface Sponsor {
    /** Absolute URL of the sponsor's site. */
    href: string;
    /** Path under `public/sponsors/`, e.g. `/sponsors/acme.svg`. */
    logo: string;
    name: string;
    tier: "partner" | "supporter" | "top";
}

/** Add a sponsor here once they have sent a logo. Empty renders the "Be the first" state. */
export const sponsors: Sponsor[] = [];

export const reasons = [
    { text: "The open-source core stays free and actively maintained.", title: "Free core, maintained" },
    { text: "Sharding, Studio, adapters, AI: the features that make Cloudflare feel native.", title: "Cloudflare-native features" },
    { text: "More developers ship realtime apps on their own account, without lock-in.", title: "No lock-in" },
    { text: "Sponsorship buys time on the road to 1.0 and the groundwork for Lunora Cloud.", title: "A faster path to 1.0" },
];

export const funds = [
    "Core framework and runtime",
    "Studio, the local admin UI",
    "Framework adapters: React, Vue, Svelte, Solid",
    "Docs and runnable examples",
    "Day-to-day maintenance: issues, reviews, releases",
    "Early groundwork for Lunora Cloud",
];

export const faq = [
    {
        answer: "Yes. The self-hosted framework stays open source. Sponsorship pays for the time it takes to maintain it.",
        question: "Is Lunora free forever?",
    },
    {
        answer: `Yes, and the $25 tier is a good place to start. If you need an invoice, email ${SPONSOR_EMAIL}.`,
        question: "Can I sponsor as a company?",
    },
    {
        answer: "Recognition plus the perks listed on your tier. Nothing is gated: sponsors and non-sponsors get the same code.",
        question: "What do I get?",
    },
    {
        answer: "Directly on Lunora development and the tools around it.",
        question: "How is the money used?",
    },
];
