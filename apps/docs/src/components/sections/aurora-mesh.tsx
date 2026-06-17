import type { FC } from "react";

import { cn } from "@/lib/utils";

/**
 * Cheap, on-brand atmospheric glow — layered aurora radials (cyan / violet /
 * rose) at low alpha. No WebGL. One per featured section (DESIGN.md §3, §6).
 *
 * `placement` controls where the light pools. Always `pointer-events-none`,
 * sits behind content (`-z-0`); parent should be `relative` (and usually
 * `overflow-hidden`).
 */
const placements: Record<string, string> = {
    bottom: "radial-gradient(50% 60% at 50% 110%, hsl(256 72% 68% / 0.16), transparent 70%), radial-gradient(40% 50% at 80% 100%, hsl(330 80% 64% / 0.10), transparent 70%)",
    center: "radial-gradient(45% 45% at 50% 45%, hsl(256 72% 68% / 0.14), transparent 70%), radial-gradient(35% 40% at 70% 55%, hsl(186 84% 56% / 0.08), transparent 70%)",
    "top-left":
        "radial-gradient(45% 55% at 18% 0%, hsl(186 84% 56% / 0.14), transparent 70%), radial-gradient(40% 50% at 40% 10%, hsl(256 72% 68% / 0.10), transparent 70%)",
    top: "radial-gradient(55% 50% at 50% -10%, hsl(256 72% 68% / 0.16), transparent 70%), radial-gradient(40% 40% at 25% 0%, hsl(186 84% 56% / 0.08), transparent 70%)",
};

const AuroraMesh: FC<{ className?: string; placement?: keyof typeof placements }> = ({ className, placement = "top" }) => (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 -z-0", className)} style={{ background: placements[placement] }} />
);

export default AuroraMesh;
