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
import type { MailboxSink } from "./capture-transport";
import { createCaptureTransport } from "./capture-transport";
import type { CloudflareSend } from "./cloudflare-transport";
import createMailer from "./create-mailer";
import type { DurableObjectJurisdiction, ShardNamespaceLike } from "./inbound/shard";
import { applyJurisdiction } from "./inbound/shard";
import type { Mailer, SendPayload } from "./types";

/** A Worker `env` projected as a plain record (vars, secrets, and bindings are `unknown`-valued). */
type MailEnv = Record<string, unknown>;

/** Reserved admin RPC the capture sink records one message through. */
const RECORD_MAIL_OP = "__lunora_admin__:recordMail";
/** Default shard the studio's Mail inbox reads from (the runtime's default shard). */
const DEFAULT_ROOT_SHARD = "__root__";
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
        throw new Error(`@lunora/mail: missing env var \`${name}\` — set it in .dev.vars (and \`wrangler secret put ${name}\` for secrets).`);
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
        return flag === "1" || flag.toLowerCase() === "true";
    }

    return ENVIRONMENT_VARS.some((key) => {
        const value = env[key];

        return typeof value === "string" && DEV_ENVIRONMENT_PATTERN.test(value);
    });
};

/**
 * Build the {@link MailboxSink} that records a captured message into the studio's
 * root-shard inbox via the reserved `recordMail` admin RPC — the same
 * worker→root-shard path the runtime uses for auth events. Best-effort: without
 * the `SHARD` binding or `LUNORA_ADMIN_TOKEN` it returns a sentinel id so a send
 * never fails for lack of somewhere to record.
 */
const createCaptureSink = (env: MailEnv, rootShard: string = DEFAULT_ROOT_SHARD, jurisdiction?: DurableObjectJurisdiction): MailboxSink => {
    return {
        record: async (mail: SendPayload): Promise<{ id: string }> => {
            const binding = env["SHARD"] as ShardNamespaceLike | undefined;
            const adminToken = typeof env["LUNORA_ADMIN_TOKEN"] === "string" ? env["LUNORA_ADMIN_TOKEN"] : undefined;

            if (binding === undefined || adminToken === undefined) {
                return { id: "uncaptured" };
            }

            const namespace = applyJurisdiction(binding, jurisdiction);
            const stub = namespace.get(namespace.idFromName(rootShard));
            const response = await stub.fetch("https://shard.internal/rpc", {
                body: JSON.stringify({ args: mail, functionPath: RECORD_MAIL_OP }),
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                method: "POST",
            });

            const body = (await response.json()) as { result?: { id?: string } };

            return { id: body.result?.id ?? "captured" };
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

    throw new Error(
        "@lunora/mail: no transport configured — provide `cloudflareSend` (a SEND_EMAIL binding) or RESEND_API_KEY, or run in a dev environment to capture.",
    );
};

export { createCaptureSink, createMailerFromEnv, shouldCaptureMail };
export type { FromEnvOptions, MailEnv };
