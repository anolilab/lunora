import type { ReactElement } from "react";

import { Badge } from "../../../components/ui/badge";

/** Colour tones for method / kind chips. Tints read on both light and dark themes. */
type Tone = "blue" | "emerald" | "neutral" | "orange" | "red" | "violet";

const TONE_CLASS: Record<Tone, string> = {
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    neutral: "bg-muted text-muted-foreground",
    orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    red: "bg-red-500/10 text-red-600 dark:text-red-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

/** HTTP method → tone, matching the conventional REST colour coding. */
const methodTone = (method: string): Tone => {
    switch (method.toUpperCase()) {
        case "DELETE": {
            return "red";
        }
        case "GET": {
            return "emerald";
        }
        case "PATCH": {
            return "orange";
        }
        case "POST": {
            return "blue";
        }
        case "PUT": {
            return "orange";
        }
        default: {
            return "neutral";
        }
    }
};

/** Cirrus function kind → tone (query reads green, mutation writes amber, action external violet). */
const kindTone = (kind: string): Tone => {
    switch (kind) {
        case "action": {
            return "violet";
        }
        case "mutation": {
            return "orange";
        }
        case "query": {
            return "emerald";
        }
        default: {
            return "neutral";
        }
    }
};

interface MethodBadgeProps {
    /** The cirrus function kind (`x-cirrus-function-kind`); when present it's the primary chip. */
    readonly kind?: string;
    /** The HTTP method. Shown when there's no function kind (e.g. a REST `httpRouter()` route). */
    readonly method: string;
    readonly testId?: string;
}

/**
 * The sidebar / header chip identifying an operation. For a Cirrus RPC function
 * the kind (query/mutation/action) is the meaningful label — every RPC op is a
 * `POST /_cirrus/rpc`, so the HTTP method alone is noise. For a plain REST route
 * (no kind) it falls back to the colour-coded HTTP method.
 */
const MethodBadge = ({ kind, method, testId }: MethodBadgeProps): ReactElement => {
    const label = kind ?? method.toUpperCase();
    const tone = kind === undefined ? methodTone(method) : kindTone(kind);

    return (
        <Badge className={`${TONE_CLASS[tone]} font-mono text-[10px] tracking-wide uppercase`} data-testid={testId} variant="ghost">
            {label}
        </Badge>
    );
};

export { kindTone, methodTone };
export default MethodBadge;
