"use client";

import { motion, useReducedMotion } from "motion/react";
import type { FC, ReactNode } from "react";

/**
 * Scroll-triggered fade-up. Respects `prefers-reduced-motion` (renders static).
 * Use `delay` to stagger siblings. See DESIGN.md §5.
 */
const Reveal: FC<{ as?: "div" | "li" | "section"; className?: string; children: ReactNode; delay?: number }> = ({
    as = "div",
    children,
    className,
    delay = 0,
}) => {
    const reduce = useReducedMotion();
    const Component = motion[as];

    if (reduce) {
        return <Component className={className}>{children}</Component>;
    }

    return (
        <Component
            className={className}
            initial={{ opacity: 0, y: 8 }}
            transition={{ delay, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            viewport={{ amount: 0.2, once: true }}
            whileInView={{ opacity: 1, y: 0 }}
        >
            {children}
        </Component>
    );
};

export default Reveal;
