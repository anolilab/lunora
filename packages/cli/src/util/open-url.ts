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

const platformOpener = (url: string): Promise<void> => {
    return new Promise<void>((resolveOpen, rejectOpen) => {
        const { args, command } = platformCommand();
        const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" });

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
 * The URL is parsed before any spawning so a malformed value (or a Windows
 * `cmd.exe`-meaningful payload) is rejected at the caller rather than handed
 * to the platform opener.
 */
export const openUrl = async (url: string, options: OpenUrlOptions = {}): Promise<void> => {
    try {
        // eslint-disable-next-line no-new -- URL throws on invalid input; we only need the parse side-effect.
        new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }

    const opener = options.opener ?? platformOpener;

    await opener(url);
};
