import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface OpenUrlOptions {
    /** Inject a custom opener (tests, alternate platforms, headless CI). */
    opener?: (url: string) => Promise<void>;
}

/**
 * Resolve the platform-default command to open a URL externally.
 * Returns the executable and its argv prefix; the URL is appended.
 */
const platformCommand = (): { args: ReadonlyArray<string>; command: string } => {
    const os = platform();

    if (os === "darwin") {
        return { args: [], command: "open" };
    }

    if (os === "win32") {
        // `start "" <url>` — the empty title placeholder keeps the URL from
        // being interpreted as a window title.
        return { args: ["/c", "start", ""], command: "cmd" };
    }

    return { args: [], command: "xdg-open" };
};

// Characters that cmd.exe re-parses even inside an argv slot (libuv only
// double-quotes args containing space/tab/quote, so these leak through to
// `cmd /c start`). Percent-encoding each keeps the value a valid URL while
// stripping its shell meaning. `%` is encoded first so we don't double-encode.
const escapeForCmd = (url: string): string =>
    url
        .replaceAll("%", "%25")
        .replaceAll("&", "%26")
        .replaceAll("|", "%7C")
        .replaceAll("^", "%5E")
        .replaceAll("<", "%3C")
        .replaceAll(">", "%3E")
        .replaceAll("(", "%28")
        .replaceAll(")", "%29")
        .replaceAll('"', "%22")
        .replaceAll("!", "%21");

const platformOpener = (url: string): Promise<void> => {
    return new Promise<void>((resolveOpen, rejectOpen) => {
        const { args, command } = platformCommand();
        const safeUrl = platform() === "win32" ? escapeForCmd(url) : url;
        const child = spawn(command, [...args, safeUrl], { detached: true, stdio: "ignore" });

        child.once("error", (error) => {
            rejectOpen(error);
        });

        child.once("spawn", () => {
            // Detach so the parent CLI doesn't wait on the launched browser.
            child.unref();
            resolveOpen();
        });
    });
};

/**
 * Open a URL in the user's default browser. Cross-platform: uses `open`,
 * `xdg-open`, or `cmd /c start` depending on the host OS. Tests pass an
 * `opener` to record the URL without spawning anything.
 *
 * The URL is parsed before any spawning, and its scheme is restricted to
 * http/https so a malformed value, a `file:`/custom-scheme payload, or a
 * Windows `cmd.exe`-meaningful payload is rejected at the caller rather than
 * handed to the platform opener. On Windows the URL is additionally
 * percent-escaped before reaching `cmd /c start` (see {@link escapeForCmd}).
 */
export const openUrl = async (url: string, options: OpenUrlOptions = {}): Promise<void> => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Refusing to open non-http(s) URL: ${url}`);
    }

    const opener = options.opener ?? platformOpener;

    await opener(url);
};
