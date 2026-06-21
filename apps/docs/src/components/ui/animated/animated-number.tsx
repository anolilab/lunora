"use client";

import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

const AnimatedNumber: FC<{ className?: string; suffix?: string; value: number }> = ({ className, suffix = "", value }) => {
    const [current, setCurrent] = useState(0);
    const ref = useRef<HTMLSpanElement>(null);
    const hasAnimated = useRef(false);
    const previousValue = useRef(value);

    useEffect(() => {
        if (previousValue.current !== value) {
            previousValue.current = value;
            hasAnimated.current = false;
            setCurrent(0);
        }

        if (hasAnimated.current || value === 0) {
            return;
        }

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry?.isIntersecting && !hasAnimated.current) {
                    hasAnimated.current = true;
                    const duration = 2000;
                    const startTime = performance.now();

                    const animate = (now: number) => {
                        const elapsed = now - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = 1 - (1 - progress) ** 3;

                        setCurrent(Math.floor(eased * value));

                        if (progress < 1) {
                            requestAnimationFrame(animate);
                        }
                    };

                    requestAnimationFrame(animate);
                    observer.disconnect();
                }
            },
            { threshold: 0.3 },
        );

        if (ref.current) {
            observer.observe(ref.current);
        }

        return () => {
            observer.disconnect();
        };
    }, [value]);

    return (
        <span className={className} ref={ref}>
            {current.toLocaleString("en-US")}
            {suffix}
        </span>
    );
};

export default AnimatedNumber;
