"use client";

import { ChevronDown } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import Section from "@/components/sections/section";
import SectionHeader from "@/components/sections/section-header";
import JsonLd from "@/components/seo/json-ld";
import { cn } from "@/lib/utils";

const faqs = [
    {
        answer: "Lunora is a type-safe, real-time backend framework built on Cloudflare Workers and Durable Objects with a Vite-first developer experience. You define a schema and write query, mutation, and action functions on the server; the client gets end-to-end typed data with live subscriptions, optimistic updates, and an offline queue.",
        question: "What is Lunora?",
    },
    {
        answer: "Yes. Lunora is open source and released under the MIT license, free to use in personal, commercial, and open-source projects without restrictions.",
        question: "Is Lunora free and open source?",
    },
    {
        answer: "Lunora runs on Cloudflare Workers and Durable Objects. Durable Objects provide SQLite-backed, transactional state at the edge, while Workers serve the RPC router and route requests to the right shard or region.",
        question: "What runtimes does Lunora support?",
    },
    {
        answer: "Lunora is TypeScript-first. Types flow from your server functions to the client via codegen, so queries, mutations, and subscriptions are checked end-to-end. Rename a field on the server and the client stops compiling.",
        question: "Is Lunora type-safe?",
    },
    {
        answer: "Yes. You can adopt Lunora incrementally. Start with the unscoped `lunora` umbrella package or just the base packages, add a single query or table, and grow from there. Opt-in add-ons like auth, mail, storage, and the framework adapters stay separate installs.",
        question: "Can I adopt Lunora incrementally?",
    },
    {
        answer: "Queries are live subscriptions. When a mutation changes the data a query reads, Lunora pushes the update over a hibernated WebSocket and every connected client re-renders automatically — no polling and no manual cache invalidation. Mutations also apply optimistically on the client and reconcile with the server's authoritative result.",
        question: "How does real-time work?",
    },
    {
        answer: "Lunora's programming model is similar to Convex — schema-first with typed query, mutation, and action functions and live queries — but Lunora runs entirely on your own Cloudflare account using Workers and Durable Objects, with a Vite-first DX and opt-in sharding (.shardBy) and global replication (.global).",
        question: "How does Lunora compare to Convex?",
    },
    {
        answer: "Lunora is developed in the open in a single monorepo on GitHub by Daniel Bannert and Anolilab. You can contribute by opening issues, submitting pull requests, or joining the conversation in GitHub Discussions.",
        question: "How is Lunora maintained?",
    },
];

const FaqItem: FC<{ answer: string; isOpen: boolean; onToggle: () => void; question: string }> = ({ answer, isOpen, onToggle, question }) => (
    <div className="border-b border-white/[0.06] bg-coal">
        <button className="flex w-full items-center justify-between py-6 text-left cursor-pointer" onClick={onToggle} type="button">
            <h3 className="text-base font-medium text-white/80">{question}</h3>
            <ChevronDown className={cn("h-5 w-5 shrink-0 text-white/30 transition-transform duration-200", isOpen && "rotate-180")} />
        </button>
        <div className={cn("grid transition-all duration-200", isOpen ? "grid-rows-[1fr] pb-6" : "grid-rows-[0fr]")}>
            <div className="overflow-hidden">
                <p className="text-sm leading-relaxed text-white/50">{answer}</p>
            </div>
        </div>
    </div>
);

const FAQ: FC = () => {
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    const faqPageJsonLd = {
        "@type": "FAQPage",
        mainEntity: faqs.map((faq) => {
            return {
                "@type": "Question",
                acceptedAnswer: { "@type": "Answer", text: faq.answer },
                name: faq.question,
            };
        }),
    };

    return (
        <div className="bg-coal border-t border-white/[0.06]">
            <JsonLd data={faqPageJsonLd} />
            <Section gridLength={0} mode="dark">
                <SectionHeader className="col-span-2 lg:col-span-4" eyebrow="FAQ" subhead="Common questions about Lunora." title="Frequently asked questions" />
                <div className="col-span-2 mt-8 border-t border-white/[0.06] lg:col-span-4">
                    {faqs.map((faq, index) => (
                        <FaqItem
                            answer={faq.answer}
                            isOpen={openIndex === index}
                            key={faq.question}
                            onToggle={() => {
                                setOpenIndex(openIndex === index ? null : index);
                            }}
                            question={faq.question}
                        />
                    ))}
                </div>
            </Section>
        </div>
    );
};

export default FAQ;
