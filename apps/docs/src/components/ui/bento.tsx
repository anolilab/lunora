import { ArrowRightIcon } from "@radix-ui/react-icons";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import CanvasRevealEffect from "@/components/ui/canvas-reveal-effect";
import { cn } from "@/lib/utils";

export const BentoGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={cn("grid w-full grid-cols-4", className)}>{children}</div>
);

export const BentoCard = ({
    background,
    className,
    cta,
    description,
    href,
    Icon,
    name,
}: {
    background: ReactNode;
    className: string;
    cta: string;
    description: string;
    href: string;
    Icon: any;
    name: string;
}) => (
    <div
        className={cn(
            "group relative col-span-4 flex flex-col justify-between overflow-hidden",
            "bg-background transform-gpu [box-shadow:0_-20px_80px_-20px_#ffffff1f_inset]",
            className,
        )}
        key={name}
    >
        <div>{background}</div>
        <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-1 p-6 transition-all duration-300 group-hover:-translate-y-10">
            <Icon className="h-12 w-12 origin-left transform-gpu text-neutral-700 transition-all duration-300 ease-in-out group-hover:scale-75" />
            <h3 className="text-xl font-semibold text-white">{name}</h3>
            <p className="max-w-lg text-neutral-400">{description}</p>
        </div>

        <div
            className={cn(
                "pointer-events-none absolute bottom-0 flex w-full translate-y-10 transform-gpu flex-row items-center p-4 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100",
            )}
        >
            <Button asChild className="pointer-events-auto" size="sm" variant="ghost">
                <a href={href}>
                    {cta}
                    <ArrowRightIcon className="ml-2 h-4 w-4" />
                </a>
            </Button>
        </div>
        <div className="pointer-events-none absolute inset-0 transform-gpu transition-all duration-300 group-hover:bg-black/[.03] dark:group-hover:bg-neutral-800/10" />
    </div>
);

export const BentoSpotlightCard = ({
    className,
    color = "#262626",
    description,
    Icon,
    name,
    radius = 350,
    revealColors = [
        [59, 130, 246],
        [139, 92, 246],
    ],
}: {
    className: string;
    color?: string;
    description: string;
    Icon: any;
    name: string;
    radius?: number;
    revealColors?: number[][];
}) => {
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    function handleMouseMove({ clientX, clientY, currentTarget }: ReactMouseEvent<HTMLDivElement>) {
        const { left, top } = currentTarget.getBoundingClientRect();

        mouseX.set(clientX - left);
        mouseY.set(clientY - top);
    }

    const maskImage = useMotionTemplate`radial-gradient(${radius}px circle at ${mouseX}px ${mouseY}px, white, transparent 80%)`;

    const [isHovering, setIsHovering] = useState(false);
    const handleMouseEnter = () => {
        setIsHovering(true);
    };
    const handleMouseLeave = () => {
        setIsHovering(false);
    };

    return (
        <div
            className={cn("group/spotlight group relative col-span-4 flex flex-col justify-between overflow-hidden", "transform-gpu", className)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onMouseMove={handleMouseMove}
        >
            <motion.div
                className="pointer-events-none absolute -inset-px z-0 rounded-md opacity-0 transition duration-300 group-hover/spotlight:opacity-100"
                style={{
                    backgroundColor: color,
                    maskImage,
                }}
            >
                {isHovering && (
                    <CanvasRevealEffect animationSpeed={5} colors={revealColors} containerClassName="bg-transparent absolute inset-0 pointer-events-none" />
                )}
            </motion.div>
            <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-2 p-6 transition-all duration-300">
                <Icon className="my-5 h-6 w-6 origin-left transform-gpu text-white/60 transition-all duration-300 ease-in-out group-hover/spotlight:text-white group-hover/spotlight:scale-110" />
                <h3 className="text-lg font-bold tracking-tight text-white">{name}</h3>
                <p className="text-sm leading-relaxed text-white/40 transition-colors duration-300 group-hover/spotlight:text-white/55">{description}</p>
            </div>
        </div>
    );
};
