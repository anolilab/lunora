/**
 * The GitHub App client — minting an installation token and writing a commit
 * status back to the repository that triggered a build (GAPS.md A4).
 *
 * The push-to-deploy loop was open at exactly one end. A push produced a build,
 * a build produced a preview deployment, and GitHub was never told any of it: the
 * URL existed and the only way to find it was to open the dashboard and go
 * looking. A commit status is the smallest thing that closes it — it appears on
 * the commit, on the PR, and in the checks list, with a link straight to the
 * preview, which is where the person who pushed is already looking.
 *
 * A status rather than a check run or a PR comment. A check run needs a
 * `checks:write` App with its own lifecycle to keep in sync, and a comment edits
 * a conversation and re-notifies subscribers on every push. A status is a single
 * idempotent POST per state, scoped by `context`, and GitHub renders repeated
 * posts to the same context as one row that updates.
 *
 * **This is 🌐-gated.** It needs the App's id and private key — the same
 * credentials the source fetch needs, and the same ones the control plane does
 * not have yet. Absent them, {@link createGitHubApp} returns `null` and every
 * caller skips reporting rather than failing a build over a notification.
 */

/** Base64url without padding, as JWT requires. */
const toBase64Url = (bytes: ArrayBuffer | Uint8Array): string => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";

    for (const byte of view) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const encoder = new TextEncoder();

/** The PEM armour around a PKCS#8 body, and the whitespace between its lines. */
const PEM_BANNER = /-----(?:BEGIN|END) PRIVATE KEY-----/gu;
const WHITESPACE = /\s/gu;

/** What GitHub's own download looks like — the form WebCrypto cannot import. */
const PKCS1_MARKER = "BEGIN RSA PRIVATE KEY";

/**
 * Decode a PKCS#8 PEM private key to its DER bytes.
 *
 * GitHub issues App keys in PKCS#1 (`BEGIN RSA PRIVATE KEY`), which WebCrypto
 * cannot import. Converting one requires re-wrapping the DER, so this accepts
 * only PKCS#8 (`BEGIN PRIVATE KEY`) and says so — an operator converts the key
 * once with `openssl pkcs8`, which is a better answer than shipping an ASN.1
 * re-wrapper into the request path to save them one command.
 */
export const pkcs8FromPem = (pem: string): ArrayBuffer => {
    const body = pem.replaceAll(PEM_BANNER, "").replaceAll(WHITESPACE, "");

    if (body === "" || pem.includes(PKCS1_MARKER)) {
        throw new Error("github app private key must be PKCS#8 (-----BEGIN PRIVATE KEY-----); convert with `openssl pkcs8 -topk8 -nocrypt`");
    }

    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes.buffer;
};

/** How long a minted App JWT is valid. GitHub rejects anything past 10 minutes. */
const APP_JWT_TTL_SECONDS = 9 * 60;

/**
 * Mint the App-level JWT that authenticates as the App itself (not an
 * installation). `iat` is backdated a minute because GitHub rejects a token
 * whose issue time is in its future, and clock skew between us and them is
 * routine.
 */
export const mintAppJwt = async (appId: string, privateKeyPem: string, now: number): Promise<string> => {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(privateKeyPem), { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }, false, ["sign"]);
    const issuedAt = Math.floor(now / 1000) - 60;
    const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = toBase64Url(encoder.encode(JSON.stringify({ exp: issuedAt + APP_JWT_TTL_SECONDS, iat: issuedAt, iss: appId })));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));

    return `${header}.${payload}.${toBase64Url(signature)}`;
};

/** The state a commit status reports. GitHub's own vocabulary. */
export type CommitStatusState = "error" | "failure" | "pending" | "success";

export interface CommitStatus {
    /** One short sentence shown next to the status on the commit and PR. */
    description: string;
    /** The installation that grants access to this repository. */
    installationId: number;
    /** `owner/name`. */
    repository: string;
    sha: string;
    state: CommitStatusState;
    /** Where the status links to — the preview URL, or the build's log page. */
    targetUrl?: string;
}

export interface GitHubApp {
    postCommitStatus: (status: CommitStatus) => Promise<void>;
}

export interface GitHubAppOptions {
    /** Base URL for the API, so a test can point it somewhere local. */
    apiBase?: string;
    appId?: string;
    /** Distinguishes our status row from every other integration's on the same commit. */
    context?: string;
    fetch?: typeof globalThis.fetch;
    privateKeyPem?: string;
}

/** The default `context` on every status we post — one row on the commit, updated in place. */
export const DEFAULT_STATUS_CONTEXT = "lunora/deploy";

const GITHUB_API = "https://api.github.com";

/** Descriptions are truncated by GitHub at 140 characters; do it here so the text stays ours. */
const MAX_DESCRIPTION = 140;

/**
 * Build the App client, or `null` when the credentials are absent.
 *
 * Returning `null` rather than throwing is deliberate: every caller is reporting
 * on work that has already happened, and a control plane without App credentials
 * must still build and deploy. The absence is a configuration state, not an
 * error at the call site.
 */
export const createGitHubApp = (options: GitHubAppOptions): GitHubApp | null => {
    const { appId, privateKeyPem } = options;

    if (!appId || !privateKeyPem) {
        return null;
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiBase = options.apiBase ?? GITHUB_API;
    const statusContext = options.context ?? DEFAULT_STATUS_CONTEXT;

    const installationToken = async (installationId: number): Promise<string> => {
        const jwt = await mintAppJwt(appId, privateKeyPem, Date.now());
        const response = await fetchImpl(`${apiBase}/app/installations/${String(installationId)}/access_tokens`, {
            headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "lunora-cloud" },
            method: "POST",
        });

        if (!response.ok) {
            throw new Error(`github installation token failed: ${String(response.status)}`);
        }

        const body: { token?: string } = await response.json();

        if (!body.token) {
            throw new Error("github installation token response carried no token");
        }

        return body.token;
    };

    return {
        postCommitStatus: async (status) => {
            const token = await installationToken(status.installationId);
            const response = await fetchImpl(`${apiBase}/repos/${status.repository}/statuses/${status.sha}`, {
                body: JSON.stringify({
                    context: statusContext,
                    description: status.description.slice(0, MAX_DESCRIPTION),
                    state: status.state,
                    ...(status.targetUrl === undefined ? {} : { target_url: status.targetUrl }),
                }),
                headers: {
                    accept: "application/vnd.github+json",
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "user-agent": "lunora-cloud",
                },
                method: "POST",
            });

            if (!response.ok) {
                throw new Error(`github commit status failed: ${String(response.status)}`);
            }
        },
    };
};
