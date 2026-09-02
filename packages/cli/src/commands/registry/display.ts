/**
 * The one terminal-display sanitizer for registry output.
 *
 * Everything a registry command renders — catalog entries, manifest fields,
 * serialized binding/env values, the file bodies `view` prints, and the error
 * messages that echo any of them back — is attacker-supplied the moment
 * `--source` or `--from` points somewhere hostile. Two classes of character are
 * stripped before it reaches the terminal.
 *
 * C0/C1 controls, because ESC is the lead-in for ANSI/OSC sequences: they
 * repaint the screen, hide text, or trigger dangerous OSC operations.
 *
 * BIDI embedding / override / isolate (U+202A–U+202E, U+2066–U+2069), because
 * they reorder a rendered line — the trojan-source vector that makes a plan line
 * read as one thing and apply as another. `JSON.stringify` escapes the first
 * class and passes the second through untouched, so serialized values need this
 * too.
 *
 * TAB is deliberately kept: it is real indentation in the source listing `view`
 * prints, and it spoofs nothing. LF is not: every call site renders one value
 * into one `logger.info` line (`view` splits a file body into lines before it
 * gets here), so a registry-controlled newline does not wrap a line — it forges
 * a new one, which is how a manifest field prints its own "✔ applied".
 *
 * One helper rather than one per module. `catalog.ts` and the command
 * orchestrators each grew their own copy of the C0/C1 regex and the two had
 * already drifted (one stripped TAB, the other did not) — which is how the BIDI
 * range ended up missing from both.
 */
// eslint-disable-next-line no-control-regex -- the C0/C1 range minus TAB is exactly what must not reach the terminal
const DISPLAY_UNSAFE_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

/** Strip everything that could repaint or reorder the line this value is rendered on. */
const safe = (value: string): string => value.replaceAll(DISPLAY_UNSAFE_CHARS, "");

/**
 * The line-scoped {@link safe}, for a value rendered INSIDE one line — a
 * plan/report/catalog field. A newline there is a line break the renderer never wrote, so
 * a registry `description` of `"chat\n  bind evil"` printed a second, fake
 * plan line after the real one. `safe` keeps LF because `view` splits file
 * bodies on it BEFORE sanitizing each line and the error paths echo multi-line
 * messages; this strips it for the sites that own exactly one line.
 */
const safeLine = (value: string): string => safe(value).replaceAll("\n", "");

export { safe, safeLine };
