/**
 * Map an HTTP/RPC response status onto the studio's semantic colours — shared by
 * the centre column's per-status response rows and the right-rail response tabs
 * so the two surfaces stay visually in sync. `2xx` reads as success (emerald),
 * `4xx` / `5xx` / the OpenAPI `default` bucket as error (red), anything else as
 * neutral muted text.
 */

/** A response status's text colour. */
const statusToneClass = (status: string): string => {
    if (status.startsWith("2")) {
        return "text-emerald-600 dark:text-emerald-400";
    }

    if (status === "default" || status.startsWith("4") || status.startsWith("5")) {
        return "text-red-600 dark:text-red-400";
    }

    return "text-muted-foreground";
};

/** The matching dot/background colour for the same status. */
const statusDotClass = (status: string): string => {
    if (status.startsWith("2")) {
        return "bg-emerald-500";
    }

    if (status === "default" || status.startsWith("4") || status.startsWith("5")) {
        return "bg-red-500";
    }

    return "bg-muted-foreground";
};

export { statusDotClass, statusToneClass };
