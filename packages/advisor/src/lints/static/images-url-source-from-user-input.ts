import type { AdvisorImageDeliveryUrlAccess } from "../../image-delivery-url-accesses";
import type { Lint } from "../../types";
import { makeArgumentDerivedSinkLint } from "../argument-derived-sink";

/**
 * Flags a `buildImageDeliveryUrl({ key, … })` call (`@lunora/bindings/images`)
 * whose `key` is derived from the handler's `args` with no server-side scoping.
 *
 * `key` is the CDN transform's source image — an absolute URL, or an
 * origin-relative key under the account's own store — that `buildImageDeliveryUrl`
 * splices into the `/cdn-cgi/image/…` delivery URL. `ctx.images.transform`/`info`
 * take image *bytes*, never a URL, so they carry no equivalent risk and are not
 * flagged. An arg-derived `key` lets any caller point the CDN's on-the-fly
 * transform at an attacker-chosen origin (SSRF / open proxy against whatever
 * that origin trusts the CDN's egress IP for) or at an arbitrary key under the
 * account's own store.
 *
 * Runs only when the codegen feeder supplies image-delivery-URL evidence
 * (`context.imageDeliveryUrlAccesses`); a runtime caller flags nothing. One
 * finding per arg-derived, unscoped `key`.
 */
const imagesUrlSourceFromUserInput: Lint = makeArgumentDerivedSinkLint<AdvisorImageDeliveryUrlAccess>({
    cacheKey: (access) => `images_url_source_from_user_input:${access.file}:${access.line.toString()}`,
    categories: ["SECURITY"],
    description:
        "A `buildImageDeliveryUrl({ key, … })` call's `key` — the CDN transform's source image, an absolute URL or an origin-relative key — is derived from the handler's `args` with no server-side scoping, so any caller can point the CDN's on-the-fly transform at an attacker-chosen origin (SSRF / open proxy) or an arbitrary key under the account's own store.",
    detail: (access) =>
        `\`buildImageDeliveryUrl\` in \`${access.exportName}\` (${access.file}:${access.line.toString()}) builds its delivery URL from a \`key\` derived from \`args\` with no server-side scoping — any caller can point the CDN's on-the-fly transform at an attacker-chosen origin or store key. Validate \`key\` against an allowlist, or derive it from server-trusted state.`,
    facing: "EXTERNAL",
    getAccesses: (context) => context.imageDeliveryUrlAccesses,
    level: "WARN",
    metadata: (access) => {
        return { exportName: access.exportName, file: access.file, line: access.line };
    },
    name: "images_url_source_from_user_input",
    remediation:
        "Validate `key` against an allowlist of known origins/prefixes before calling `buildImageDeliveryUrl`, or derive it from server-trusted state (a stored record's own image key) rather than passing `args` straight through.",
    title: "Image delivery URL built from unscoped user input",
});

export default imagesUrlSourceFromUserInput;
