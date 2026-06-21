"use client";

import { AnimatePresence, motion } from "motion/react";
import type { HTMLProps, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const beams = [
    {
        delay: 2,
        duration: 7,
        initialX: 10,
        repeatDelay: 3,
        translateX: 10,
    },
    {
        delay: 4,
        duration: 3,
        initialX: 600,
        repeatDelay: 3,
        translateX: 600,
    },
    {
        className: "h-6",
        duration: 7,
        initialX: 100,
        repeatDelay: 7,
        translateX: 100,
    },
    {
        delay: 4,
        duration: 5,
        initialX: 400,
        repeatDelay: 14,
        translateX: 400,
    },
    {
        className: "h-20",
        duration: 11,
        initialX: 800,
        repeatDelay: 2,
        translateX: 800,
    },
    {
        className: "h-12",
        duration: 4,
        initialX: 1000,
        repeatDelay: 2,
        translateX: 1000,
    },
    {
        className: "h-6",
        delay: 2,
        duration: 6,
        initialX: 1200,
        repeatDelay: 4,
        translateX: 1200,
    },
];

export const BackgroundBeamsWithCollision = ({ children, className }: { children: ReactNode; className?: string }) => {
    const containerReference = useRef<HTMLDivElement>(null);
    const parentReference = useRef<HTMLDivElement>(null);

    return (
        <div
            className={cn(
                "relative flex h-96 w-full items-center justify-center overflow-hidden bg-linear-to-b from-white to-neutral-100 md:h-[40rem] dark:from-neutral-950 dark:to-neutral-800",
                // h-screen if you want bigger
                className,
            )}
            ref={parentReference}
        >
            {beams.map((beam) => (
                <CollisionMechanism beamOptions={beam} containerRef={containerReference} key={`${beam.initialX}beam-idx`} parentRef={parentReference} />
            ))}

            {children}
            <div
                className="pointer-events-none absolute inset-x-0 bottom-0 w-full bg-neutral-100"
                ref={containerReference}
                style={{
                    boxShadow:
                        "0 0 24px rgba(34, 42, 53, 0.06), 0 1px 1px rgba(0, 0, 0, 0.05), 0 0 0 1px rgba(34, 42, 53, 0.04), 0 0 4px rgba(34, 42, 53, 0.08), 0 16px 68px rgba(47, 48, 55, 0.05), 0 1px 0 rgba(255, 255, 255, 0.1) inset",
                }}
            />
        </div>
    );
};

const CollisionMechanism = ({
    beamOptions = {},
    containerRef,
    parentRef,
    ref,
}: {
    beamOptions?: {
        className?: string;
        delay?: number;
        duration?: number;
        initialX?: number;
        initialY?: number;
        repeatDelay?: number;
        rotate?: number;
        translateX?: number;
        translateY?: number;
    };
    containerRef: RefObject<HTMLDivElement | null>;
    parentRef: RefObject<HTMLDivElement | null>;
} & { ref?: React.RefObject<HTMLDivElement | null> }) => {
    const beamReference = useRef<HTMLDivElement>(null);
    const [collision, setCollision] = useState<{
        coordinates: { x: number; y: number } | null;
        detected: boolean;
    }>({
        coordinates: null,
        detected: false,
    });
    const [beamKey, setBeamKey] = useState(0);
    const [cycleCollisionDetected, setCycleCollisionDetected] = useState(false);

    useEffect(() => {
        let rafId: number;

        const checkCollision = () => {
            if (beamReference.current && containerRef.current && parentRef.current && !cycleCollisionDetected) {
                const beamRect = beamReference.current.getBoundingClientRect();
                const containerRect = containerRef.current.getBoundingClientRect();
                const parentRect = parentRef.current.getBoundingClientRect();

                if (beamRect.bottom >= containerRect.top) {
                    const relativeX = beamRect.left - parentRect.left + beamRect.width / 2;
                    const relativeY = beamRect.bottom - parentRect.top;

                    setCollision({
                        coordinates: {
                            x: relativeX,
                            y: relativeY,
                        },
                        detected: true,
                    });
                    setCycleCollisionDetected(true);

                    return;
                }
            }

            rafId = requestAnimationFrame(checkCollision);
        };

        rafId = requestAnimationFrame(checkCollision);

        return () => {
            cancelAnimationFrame(rafId);
        };
    }, [cycleCollisionDetected, containerRef]);

    useEffect(() => {
        if (collision.detected && collision.coordinates) {
            setTimeout(() => {
                setCollision({ coordinates: null, detected: false });
                setCycleCollisionDetected(false);
            }, 2000);

            setTimeout(() => {
                setBeamKey((previousKey) => previousKey + 1);
            }, 2000);
        }
    }, [collision]);

    return (
        <>
            <motion.div
                animate="animate"
                className={cn(
                    "absolute top-20 left-0 m-auto h-14 w-px rounded-full bg-linear-to-t from-indigo-500 via-purple-500 to-transparent",
                    beamOptions.className,
                )}
                initial={{
                    rotate: beamOptions.rotate || 0,
                    translateX: beamOptions.initialX || "0px",
                    translateY: beamOptions.initialY || "-200px",
                }}
                key={beamKey}
                ref={beamReference}
                transition={{
                    delay: beamOptions.delay || 0,
                    duration: beamOptions.duration || 8,
                    ease: "linear",
                    repeat: Infinity,
                    repeatDelay: beamOptions.repeatDelay || 0,
                    repeatType: "loop",
                }}
                variants={{
                    animate: {
                        rotate: beamOptions.rotate || 0,
                        translateX: beamOptions.translateX || "0px",
                        translateY: beamOptions.translateY || "1800px",
                    },
                }}
            />
            <AnimatePresence>
                {collision.detected && collision.coordinates && (
                    <Explosion
                        className=""
                        key={`${collision.coordinates.x}-${collision.coordinates.y}`}
                        style={{
                            left: `${collision.coordinates.x}px`,
                            top: `${collision.coordinates.y}px`,
                            transform: "translate(-50%, -50%)",
                        }}
                    />
                )}
            </AnimatePresence>
        </>
    );
};

CollisionMechanism.displayName = "CollisionMechanism";

const Explosion = ({ ...properties }: HTMLProps<HTMLDivElement>) => {
    const spans = Array.from({ length: 20 }, (_, index) => {
        return {
            directionX: Math.floor(Math.random() * 80 - 40),
            directionY: Math.floor(Math.random() * -50 - 10),
            id: index,
            initialX: 0,
            initialY: 0,
        };
    });

    return (
        <div {...properties} className={cn("absolute z-50 h-2 w-2", properties.className)}>
            <motion.div
                animate={{ opacity: 1 }}
                className="absolute -inset-x-10 top-0 m-auto h-2 w-10 rounded-full bg-linear-to-r from-transparent via-indigo-500 to-transparent blur-xs"
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={{ duration: 1.5, ease: "easeOut" }}
            />
            {spans.map((span) => (
                <motion.span
                    animate={{
                        opacity: 0,
                        x: span.directionX,
                        y: span.directionY,
                    }}
                    className="absolute h-1 w-1 rounded-full bg-linear-to-b from-indigo-500 to-purple-500"
                    initial={{ opacity: 1, x: span.initialX, y: span.initialY }}
                    key={span.id}
                    transition={{ duration: Math.random() * 1.5 + 0.5, ease: "easeOut" }}
                />
            ))}
        </div>
    );
};
