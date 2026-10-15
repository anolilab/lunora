/**
 * Deployment protection for preview deployments (GAPS.md B-series follow-on).
 *
 * A preview deployment is a real, publicly-addressable URL the moment it exists.
 * That is the point of a preview — you paste it to a colleague — but it also
 * means an unreleased feature, a staging dataset and a half-finished page are all
 * served to anyone who guesses or is forwarded the hostname. Every comparable
 * platform gates previews behind something; this is that gate.
 *
 * **Where the secret lives.** The password's salted hash never leaves the control
 * plane: the dispatcher forwards a submitted password for verification and, on
 * success, mints a signed cookie. Every later request is then a LOCAL signature
 * check with no round trip, so protection costs one control-plane call per login
 * rather than one per request.
 *
 * **Where the signing key comes from.** Derived from the control-plane token the
 * dispatcher already holds, domain-separated by a fixed label
 * (`HMAC(token, "lunora-preview-auth-v1")`). Two reasons: a bearer token must not
 * double as a signing key — different purpose, different key — and deriving means
 * the feature works the moment someone enables protection, rather than depending
 * on an operator having provisioned yet another secret that, if missed, would
 * leave previews silently unprotected. Rotating the control-plane token
 * invalidates outstanding cookies, which is the correct blast radius.
 *
 * Signing, verification and cookie parsing are unit-tested; the WebCrypto calls are
 * async. The login flow (`guardProtectedPreview`) adds the one control-plane call
 * and the password prompt on top of them.
 */
import { fromBase64Url, toBase64Url } from "../../../../shared/base64";
import { constantTimeEqual } from "../security/constant-time-equal";

/** Cookie the dispatcher sets once a preview password has been accepted. */
const PREVIEW_COOKIE_NAME = "__lunora_preview";

/** Domain-separation label — see the module note on why the key is derived rather than reused. */
const SIGNING_LABEL = "lunora-preview-auth-v1";

/** How long a preview session lasts before the password is asked for again (12 h). */
const PREVIEW_SESSION_MS = 12 * 60 * 60 * 1000;

/** Derive the HMAC key for cookie signing from the control-plane token. */
const signingKey = async (controlPlaneToken: string): Promise<CryptoKey> => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(controlPlaneToken), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(SIGNING_LABEL));

    return crypto.subtle.importKey("raw", derived, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
};

/** The claims a preview cookie carries. Deliberately tiny — a scope and a deadline, nothing else. */
interface PreviewClaims {
    /** Expiry, epoch millis. */
    exp: number;
    /** The script this cookie authorises. A cookie for one preview must not open another. */
    script: string;
}

/**
 * Mint a signed cookie value authorising one script until `now + PREVIEW_SESSION_MS`.
 *
 * The script name is inside the SIGNED payload rather than implied by the cookie's
 * host. Preview hostnames share a parent domain, so a host-scoped cookie would be
 * sent to every other preview in the account — signing the scope means a cookie
 * for one preview is rejected by the next even though the browser offers it.
 */
export const signPreviewToken = async (script: string, controlPlaneToken: string, now: number = Date.now()): Promise<string> => {
    const claims: PreviewClaims = { exp: now + PREVIEW_SESSION_MS, script };
    const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign("HMAC", await signingKey(controlPlaneToken), new TextEncoder().encode(payload));

    return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * Verify a cookie value for one script. `false` for anything that is not a valid,
 * unexpired signature over that exact script.
 *
 * Verification recomputes the signature and compares in constant time rather than
 * trusting the payload first: the claims are attacker-supplied until the MAC says
 * otherwise, so nothing is read out of them before the check passes.
 */
export const verifyPreviewToken = async (token: string, script: string, controlPlaneToken: string, now: number = Date.now()): Promise<boolean> => {
    const separator = token.indexOf(".");

    if (separator <= 0 || separator === token.length - 1) {
        return false;
    }

    const payload = token.slice(0, separator);
    const presented = token.slice(separator + 1);

    let expected: string;

    try {
        const signature = await crypto.subtle.sign("HMAC", await signingKey(controlPlaneToken), new TextEncoder().encode(payload));

        expected = toBase64Url(new Uint8Array(signature));
    } catch {
        return false;
    }

    if (!constantTimeEqual(presented, expected)) {
        return false;
    }

    // Only now are the claims trustworthy enough to read.
    let claims: PreviewClaims;

    try {
        claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as PreviewClaims;
    } catch {
        return false;
    }

    return claims.script === script && typeof claims.exp === "number" && claims.exp > now;
};

/**
 * Read one cookie's value out of a `Cookie` header.
 *
 * Splits on `;` and takes the first `=` only, because a base64url payload can
 * itself contain no `=` but the joined token can — a naive `split("=")` would
 * truncate the value.
 */
export const readCookie = (header: null | string): string | undefined => {
    for (const part of (header ?? "").split(";")) {
        const trimmed = part.trim();
        const equals = trimmed.indexOf("=");

        if (equals > 0 && trimmed.slice(0, equals) === PREVIEW_COOKIE_NAME) {
            return trimmed.slice(equals + 1);
        }
    }

    return undefined;
};

/**
 * The `Set-Cookie` value for a minted token.
 *
 * `HttpOnly` because no script needs to read it and a preview is exactly where
 * half-finished code runs; `Secure` because previews are HTTPS-only; `SameSite=Lax`
 * so following a shared link still carries it while a cross-site POST does not.
 * Host-scoped (no `Domain`) so the browser does not offer it to sibling previews —
 * belt to the signed scope's braces.
 */
export const previewCookieHeader = (token: string): string =>
    `${PREVIEW_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(Math.floor(PREVIEW_SESSION_MS / 1000))}`;

/** Path the protection login form posts to. Owned by the dispatcher, never forwarded to the tenant. */
const PREVIEW_AUTH_PATH = "/__lunora/preview-auth";

/**
 * The password prompt. Deliberately a plain, dependency-free document: it is
 * served in front of someone else's application, so it must not assume a
 * framework, a stylesheet or a build step, and it must render identically
 * whatever the tenant happens to be.
 */
const PREVIEW_LOGIN_STYLE =
    "body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0d1117;color:#e3e8ef}" +
    "form{display:grid;gap:12px;width:min(320px,90vw)}h1{font-size:19px;margin:0}p{margin:0;color:#97a2b0;font-size:14px}" +
    "input,button{font:inherit;padding:9px 12px;border-radius:6px;border:1px solid #28313c}" +
    "input{background:#161c24;color:inherit}button{background:#e3e8ef;color:#0d1117;border:0;cursor:pointer;font-weight:600}" +
    ".e{color:#de7a70;font-size:14px}";

const previewLoginPage = (failed: boolean): Response =>
    new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Protected preview</title>
<style>${PREVIEW_LOGIN_STYLE}</style></head><body>
<form method="POST" action="${PREVIEW_AUTH_PATH}">
<h1>This preview is protected</h1>
<p>Enter the password shared by the project's team.</p>
<input type="password" name="password" aria-label="Preview password" autocomplete="current-password" autofocus required><!-- secret-scanner:allow -- an autocomplete hint on a login form, not a credential -->
${failed ? `<p class="e">That password did not match.</p>` : ""}
<button type="submit">View preview</button>
</form></body></html>`,
        // 401 rather than 200: this is an authentication challenge, and a crawler
        // or an uptime check must not record a protected preview as healthy
        // content. `no-store` because a cached prompt would survive the login.
        { headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" }, status: 401 },
    );

/** The control plane as the login flow uses it: the bearer, and the base URL with no trailing slash. */
interface PreviewControlPlane {
    token: string;
    url: string;
}

/**
 * Ask the control plane whether a submitted password is the project's. Never throws.
 *
 * Forwards the END USER's address so the control plane can throttle guesses per
 * attacker. Without it every attempt keys on the dispatcher, which neither
 * isolates one grinder nor stops them throttling everybody else.
 */
const passwordAccepted = async (password: string, scriptName: string, plane: PreviewControlPlane, clientIp: null | string): Promise<boolean> => {
    try {
        const response = await fetch(`${plane.url}/v1/tenants/preview-auth`, {
            body: JSON.stringify({ password, scriptName }),
            headers: {
                authorization: `Bearer ${plane.token}`,
                "content-type": "application/json",
                "x-lunora-client-ip": clientIp ?? "unknown",
            },
            method: "POST",
        });

        if (!response.ok) {
            return false;
        }

        const body: { ok?: boolean } = await response.json();

        return body.ok === true;
    } catch {
        // A control-plane blip must not accept a password it never verified.
        return false;
    }
};

/** Handle the login form POST: verify, then mint the cookie. */
const handlePreviewLogin = async (request: Request, scriptName: string, plane: PreviewControlPlane): Promise<Response> => {
    const form = await request.formData().catch(() => undefined);
    const password = form?.get("password");

    if (typeof password !== "string" || password === "" || !(await passwordAccepted(password, scriptName, plane, request.headers.get("cf-connecting-ip")))) {
        return previewLoginPage(true);
    }

    // 303 so the browser follows with GET — a 302 would replay the POST.
    return new Response(null, {
        headers: {
            location: "/",
            "set-cookie": previewCookieHeader(await signPreviewToken(scriptName, plane.token)),
        },
        status: 303,
    });
};

/**
 * Enforce deployment protection for one request, or return `undefined` to let it
 * through. Called only for a protected preview.
 *
 * Handles the login POST itself so the tenant never sees the password: a form
 * submission to {@link PREVIEW_AUTH_PATH} is verified against the control plane,
 * and on success the dispatcher mints its own signed cookie and redirects back.
 * `plane.url` must already be stripped of trailing slashes.
 */
export const guardProtectedPreview = async (request: Request, url: URL, scriptName: string, plane: PreviewControlPlane): Promise<Response | undefined> => {
    if (request.method === "POST" && url.pathname === PREVIEW_AUTH_PATH) {
        return handlePreviewLogin(request, scriptName, plane);
    }

    const cookie = readCookie(request.headers.get("cookie"));

    if (cookie !== undefined && (await verifyPreviewToken(cookie, scriptName, plane.token))) {
        return undefined;
    }

    return previewLoginPage(false);
};

export { PREVIEW_COOKIE_NAME, PREVIEW_SESSION_MS };
