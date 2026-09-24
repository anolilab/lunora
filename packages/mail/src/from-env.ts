/**
 * Build a mailer straight from a Worker `env`, picking the transport by
 * environment: capture into the studio's dev mail catcher when running in
 * development, otherwise deliver via Cloudflare Email Workers (or Resend). This
 * is the single home for that decision so every place that sends mail — the
 * `mail` registry scaffold AND the `auth` scaffold's verification /
 * forgot-password callbacks — behaves identically (and auth mail shows up in the
 * catcher).
 *
 * Runtime-agnostic by design: `env` is a plain record, the `SHARD` Durable
 * Object namespace is projected structurally, and the only I/O is `fetch` on the
 * shard stub. The Cloudflare-binding-specific `send(from, to, raw)` callback is
 * injected by the scaffold (it needs `cloudflare:email`), keeping this module
 * free of any Cloudflare import.
 */
import { LunoraError } from "@lunora/errors";

import type { MailboxSink } from "./capture-transport";
import { createCaptureTransport } from "./capture-transport";
import type { CloudflareSend } from "./cloudflare-transport";
import createMailer from "./create-mailer";
import type { DurableObjectJurisdiction, ShardNamespaceLike } from "./inbound/shard";
import { DEFAULT_ROOT_SHARD, postShardRpc } from "./inbound/shard";
import type { Mailer, SendPayload } from "./types";

/** A Worker `env` projected as a plain record (vars, secrets, and bindings are `unknown`-valued). */
type MailEnv = Record<string, unknown>;

/** Reserved admin RPC the capture sink records one message through. */
const RECORD_MAIL_OP = "__lunora_admin__:recordMail";
/** Env-name values that denote a development deployment (`lunora dev` sets `WORKER_ENV=development`). */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/** Options for {@link createMailerFromEnv}. */
interface FromEnvOptions {
    /** RFC 822 send callback bound to the Worker's `send_email` binding (Cloudflare default transport). */
    cloudflareSend?: CloudflareSend;

    /**
     * Pin the captured-mail inbox shard to a Cloudflare data-residency
     * jurisdiction. Pass the same value as the worker's `jurisdiction` so the
     * dev inbox co-resides with app data. Omit for the un-pinned global namespace.
     */
    jurisdiction?: DurableObjectJurisdiction;
    /** Shard the captured-mail inbox lives on; override if your worker sets a custom `defaultShardKey`. */
    rootShard?: string;
}

const requireStringEnv = (env: MailEnv, name: string): string => {
    const value = env[name];

    if (typeof value !== "string" || value === "") {
        throw new LunoraError("INTERNAL", `@lunora/mail: missing env var \`${name}\` — set it in .dev.vars (and \`wrangler secret put ${name}\` for secrets).`);
    }

    return value;
};

/**
 * Whether outbound mail should be captured (into the studio inbox) rather than
 * delivered. Explicit `LUNORA_MAIL_CAPTURE` (`"1"`/`"true"` vs `"0"`/`"false"`)
 * always wins; unset, capture is on only in a development environment. It does
 * NOT fall back to "no SEND_EMAIL binding ⇒ capture" — a production deploy that
 * forgot the binding must fail loudly on send, not silently swallow mail.
 */
const shouldCaptureMail = (env: MailEnv): boolean => {
    const flag = env["LUNORA_MAIL_CAPTURE"];

    if (typeof flag === "string") {
        const normalized = flag.toLowerCase();

        if (normalized === "1" || normalized === "true") {
            return true;
        }

        if (normalized === "0" || normalized === "false") {
            return false;
        }

        // Any other value (e.g. "yes", "on", a typo) is NOT an explicit override —
        // fall through to environment detection rather than silently forcing
        // capture off (which would send real provider mail from a dev box).
        // eslint-disable-next-line no-console -- surface a likely-misconfigured flag rather than swallowing it
        console.warn(
            `@lunora/mail: unrecognized LUNORA_MAIL_CAPTURE value "${flag}" — expected "1"/"true" or "0"/"false"; falling back to environment detection.`,
        );
    }

    return ENVIRONMENT_VARS.some((key) => {
        const value = env[key];

        return typeof value === "string" && DEV_ENVIRONMENT_PATTERN.test(value);
    });
};

/**
 * Whether the "capture has nowhere to record" warning has already been emitted in
 * this isolate. Module-level so a dev loop that sends constantly says it once
 * instead of once per message — the same shape as the notify facade's one-time
 * no-store warning.
 */
let warnedNoCaptureTarget = false;

/**
 * Build the {@link MailboxSink} that records a captured message into the studio's
 * root-shard inbox via the reserved `recordMail` admin RPC — the same
 * worker→root-shard path the runtime uses for auth events. Best-effort: without
 * the `SHARD` binding or `LUNORA_ADMIN_TOKEN` it returns a sentinel id so a send
 * never fails for lack of somewhere to record — but it says so first (see below).
 */
const createCaptureSink = (env: MailEnv, rootShard: string = DEFAULT_ROOT_SHARD, jurisdiction?: DurableObjectJurisdiction): MailboxSink => {
    return {
        record: async (mail: SendPayload): Promise<{ id: string }> => {
            const binding = env["SHARD"] as ShardNamespaceLike | undefined;
            const adminToken = typeof env["LUNORA_ADMIN_TOKEN"] === "string" ? env["LUNORA_ADMIN_TOKEN"] : undefined;

            if (binding === undefined || adminToken === undefined) {
                // Not silent. Capture is selected by a DEV-LOOKING environment
                // variable (`shouldCaptureMail`), so a deploy that happens to ship
                // `NODE_ENV=test` or `ENVIRONMENT=local`, or a dev box missing the
                // admin token, swallows every message — verification links, password
                // resets and OTPs included — while returning a success-shaped id.
                // The sibling RPC-failure branch below has always logged; this one
                // returned the same sentinel with nothing in the tail to explain it.
                if (!warnedNoCaptureTarget) {
                    warnedNoCaptureTarget = true;
                    // eslint-disable-next-line no-console -- one-time misconfiguration warning, mirrors the RPC-failure branch below
                    console.warn(
                        "@lunora/mail: capturing mail but there is nowhere to record it — the `SHARD` binding and/or `LUNORA_ADMIN_TOKEN` is missing, so every captured message is discarded. Set both to see mail in the studio inbox, or set LUNORA_MAIL_CAPTURE=0 to deliver for real.",
                    );
                }

                return { id: "uncaptured" };
            }

            // Best-effort: a send must never fail for lack of somewhere to record.
            // `postShardRpc` throws on a non-2xx / error envelope (wrong admin
            // token, missing route, shard error) — catch it and surface a loud
            // diagnostic instead of returning a bogus success id for lost mail.
            try {
                const body = (await postShardRpc(binding, {
                    adminToken,
                    envelope: { args: mail, functionPath: RECORD_MAIL_OP },
                    jurisdiction,
                    label: "@lunora/mail: recording captured mail",
                    shardKey: rootShard,
                })) as { result?: { id?: string } };

                return { id: body.result?.id ?? "captured" };
            } catch (error) {
                // eslint-disable-next-line no-console -- best-effort sink: log the drop rather than failing the send
                console.error("@lunora/mail: failed to record captured mail into the studio inbox —", error);

                return { id: "uncaptured" };
            }
        },
    };
};

/**
 * Build a {@link Mailer} from a Worker `env`. In a dev environment every send is
 * captured into the studio's Mail inbox; otherwise it delivers via the supplied
 * `cloudflareSend` (the `SEND_EMAIL` binding) or, failing that, `RESEND_API_KEY`.
 * Throws when neither a capture context nor a real transport is available, so a
 * misconfigured production deploy fails loudly instead of silently dropping mail.
 *
 * `MAIL_FROM` is required (the default sender).
 */
const createMailerFromEnv = (env: MailEnv, options: FromEnvOptions = {}): Mailer => {
    const from = requireStringEnv(env, "MAIL_FROM");

    if (shouldCaptureMail(env)) {
        return createMailer({ from, transport: createCaptureTransport(createCaptureSink(env, options.rootShard, options.jurisdiction)) });
    }

    if (options.cloudflareSend) {
        return createMailer({ cloudflareSend: options.cloudflareSend, from });
    }

    const apiKey = typeof env["RESEND_API_KEY"] === "string" ? env["RESEND_API_KEY"] : undefined;

    if (apiKey !== undefined && apiKey !== "") {
        return createMailer({ apiKey, from });
    }

    throw new LunoraError(
        "INTERNAL",
        "@lunora/mail: no transport configured — provide `cloudflareSend` (a SEND_EMAIL binding) or RESEND_API_KEY, or run in a dev environment to capture.",
    );
};

export { createCaptureSink, createMailerFromEnv, shouldCaptureMail };
export type { FromEnvOptions, MailEnv };
