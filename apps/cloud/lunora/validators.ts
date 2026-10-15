import type { Validator } from "@lunora/values";

import { v } from "./_generated/server.js";

/*
 * Length-bounded string arguments for the control plane's public procedures.
 *
 * Every public `v.string()` arg needs a max-length bound — an unbounded one lets a
 * client post megabytes per request (the `unbounded_string_arg` advisory). Written
 * inline, that bound appears THREE times per argument: the predicate, the message,
 * and the JSON Schema fragment. Across ~77 arguments that was 231 places a number
 * could drift, and it did — a numeric-separator autofix reached inside the message
 * literals, so ten of them told users "must be at most 2_048 characters". Formatting
 * the message from the same number that is enforced means the three cannot disagree.
 *
 * This does not blind the advisory. Codegen's detector tests for `v.string(` FIRST
 * and only then for a bound, so a `boundedString(…)` call never enters the unbounded
 * bucket at all and the bound-matching fallback is never consulted. A bare
 * `v.string()` anywhere still flags, as it should.
 */

/*
 * `.check()` widens away the string-specific builder methods (`.max`, `.email`,
 * …), so the annotation is `Validator<string>` rather than `ReturnType<typeof
 * v.string>`. `v.string().max(max)` is now first-class sugar for this exact
 * predicate + `maxLength` fragment; it is kept spelled out here only for the
 * message, which reads for an API consumer rather than "expected string length
 * <= 2048".
 */
/** A string argument capped at `max` characters, enforced and described consistently. */
export const boundedString = (max: number): Validator<string> =>
    v.string().check((value) => value.length <= max, { message: `must be at most ${String(max)} characters`, schema: { maxLength: max } });

/**
 * The semantic size classes the arguments actually fall into. Named rather than
 * inlined so a reader sees *why* a bound is what it is, and so widening a class
 * (say, longer deploy keys) is one edit rather than twenty-three.
 */
export const LIMITS = {
    /** Envelope-encrypted admin token (ciphertext is larger than its plaintext). */
    cipher: 4096,
    /** RFC 5321 maximum email path. */
    email: 320,
    /** A git ref. */
    gitRef: 255,
    /** DNS hostname — RFC 1035 maximum FQDN. */
    hostname: 253,
    /** An opaque id or hex digest: W3C trace id, SHA-256, an IV, a semver, a slug. */
    id: 64,
    /** A human-facing name, a Cloudflare script id, an external user/session/price id, or one cron expression. */
    name: 128,
    /** A sealed admin bearer for the tenant admin proxy. */
    sealedToken: 1024,
    /** Envelope-encrypted secret value. */
    secret: 8192,
    /** A provider webhook signature header. */
    signature: 512,
    /** Short enum-shaped value, e.g. a Durable Object jurisdiction. */
    tag: 32,
    /** A bearer token, `owner/repo` path, function path, or free-text search term. */
    token: 256,
    /** A URL (redirect, webhook destination, deployment URL). */
    url: 2048,
    /** A raw provider webhook payload, read before signature verification. */
    webhookBody: 262_144,
} as const;
