import type { ReactElement } from "react";

import { Badge } from "../../../components/ui/badge";

/** Colour tones for method / kind chips, mapped to the Lunora aurora + data-status palette. */
type Tone = "blue" | "emerald" | "neutral" | "orange" | "red" | "violet";

const TONE_CLASS: Record<Tone, string> = {
    blue: "text-info",
    emerald: "text-success",
    neutral: "text-muted-foreground",
    orange: "text-warning",
    red: "text-destructive",
    violet: "text-royal-amethyst",
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

/** Lunora function kind → tone (query reads green, mutation writes amber, action external violet). */
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
    /** The lunora function kind (`x-lunora-function-kind`); when present it's the primary chip. */
    readonly kind?: string;
    /** The HTTP method. Shown when there's no function kind (e.g. a REST `httpRouter()` route). */
    readonly method: string;
    readonly testId?: string;
}

/**
 * The sidebar / header chip identifying an operation. For a Lunora RPC function
 * the kind (query/mutation/action) is the meaningful label — every RPC op is a
 * `POST /_lunora/rpc`, so the HTTP method alone is noise. For a plain REST route
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
