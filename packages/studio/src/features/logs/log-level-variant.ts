import type { LogLevel } from "../../lib/admin";

/** The shadcn Badge variants the log feeds use for severity chips. */
export type BadgeVariant = "default" | "destructive" | "outline" | "secondary";

/**
 * Maps a log level to a shadcn Badge variant for Supabase-style severity chips.
 * `fatal` shares `error`'s destructive tone (it is the louder of the two, and the
 * label itself distinguishes them); `trace` reads quieter than `debug`, and the
 * default `log` tier reads like `info`. Shared by the live Logs feeds and the
 * durable Archive feed so a level always reads the same colour.
 */
export const LEVEL_VARIANT: Record<LogLevel, BadgeVariant> = {
    debug: "secondary",
    error: "destructive",
    fatal: "destructive",
    info: "outline",
    log: "outline",
    trace: "outline",
    warn: "secondary",
};
