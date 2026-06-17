import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import Reveal from "@/components/sections/reveal";
import Section from "@/components/sections/section";
import { Button } from "@/components/ui/button";

/**
 * The single light-mode contrast band (DESIGN.md §3) — a lavender-tinted
 * moonlight finale with the primary call to action, between the dark page and
 * the dark footer.
 */
const CtaBand = () => (
    <div className="relative overflow-hidden bg-gradient-to-b from-[hsl(250_45%_95%)] to-[hsl(228_32%_97%)]" data-theme="light">
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-0"
            style={{ background: "radial-gradient(60% 80% at 50% 0%, hsl(256 72% 68% / 0.18), transparent 70%)" }}
        />
        <Section classes={{ root: "relative z-10" }} gridLength={0} mode="light">
            <Reveal className="col-span-full flex flex-col items-center gap-6 py-10 text-center">
                <span className="text-coal/50 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
                    <span className="bg-royal-amethyst size-1.5 rounded-full" />
                    Ship today
                </span>
                <h2 className="font-display text-coal max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                    Build realtime, on the edge.
                </h2>
                <p className="text-coal/60 max-w-xl text-base md:text-lg">
                    Define a schema, write typed functions, and ship live, end-to-end typed apps on Cloudflare — in an afternoon.
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                    <Button
                        asChild
                        className="bg-coal hover:bg-coal/90 group h-11 gap-2 rounded-none px-6 text-base font-semibold text-white"
                        variant="default"
                    >
                        <Link to="/docs/$">
                            Get started
                            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
                        </Link>
                    </Button>
                    <Button
                        asChild
                        className="border-coal/20 text-coal hover:bg-coal/[0.04] h-11 gap-2 rounded-none bg-transparent px-6 text-base font-medium"
                        variant="outline"
                    >
                        <Link to="/packages">Browse packages</Link>
                    </Button>
                </div>
            </Reveal>
        </Section>
    </div>
);

export default CtaBand;
