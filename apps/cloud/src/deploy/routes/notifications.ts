import { api } from "../../../lunora/_generated/api";
import { isNotificationEvent, isNotificationKind } from "../../notifications/events";
import { encryptSecret } from "../../secrets/crypto";
import { randomSecret } from "../keys";
import type { RouterEnv } from "./shared";
import { jsonError, rejected } from "./shared";

/** Body of `POST /v1/notification-channels`. Untrusted until narrowed below. */
interface NotificationChannelBody {
    destination?: string;
    events?: unknown[];
    kind?: unknown;
    name?: string;
    organizationId?: string;
    secret?: string;
}

/** Seal a channel's secret at the edge. A response to return instead when the key is missing or sealing fails. */
const sealChannelSecret = async (
    environment: RouterEnv,
    secret: string | undefined,
): Promise<{ response: Response } | { sealed: { ciphertext: string; iv: string } | undefined }> => {
    if (!secret) {
        return { sealed: undefined };
    }

    if (!environment.SECRET_ENCRYPTION_KEY) {
        return { response: jsonError(500, "SECRET_ENCRYPTION_KEY not configured") };
    }

    try {
        return { sealed: await encryptSecret(environment.SECRET_ENCRYPTION_KEY, secret) };
    } catch (error) {
        return { response: jsonError(500, error instanceof Error ? error.message : "secret encryption failed") };
    }
};

/**
 * `POST /v1/notification-channels` — create a lifecycle notification channel. A
 * webhook channel gets a freshly generated signing key, returned here once; a
 * Telegram channel takes its bot token. Either secret is sealed at the edge with
 * SECRET_ENCRYPTION_KEY before it reaches the mutation, so the database holds only
 * ciphertext. Owner/admin gating happens in `notifications.createChannel`.
 */
export const handleNotificationChannelRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = environment.__lunoraCtx;

    if (!context) {
        return jsonError(500, "lunora context unavailable");
    }

    const body = (await request.json().catch(() => null)) as NotificationChannelBody | null;

    if (!body?.organizationId || !body.name || !body.destination || !isNotificationKind(body.kind)) {
        return jsonError(400, "organizationId, name, kind and destination are required");
    }

    const events = Array.isArray(body.events) ? body.events.filter(isNotificationEvent) : undefined;
    const signingKey = body.kind === "webhook" ? randomSecret() : undefined;
    const secret = body.kind === "telegram" ? body.secret?.trim() : signingKey;
    const sealing = await sealChannelSecret(environment, secret);

    if ("response" in sealing) {
        return sealing.response;
    }

    const { sealed } = sealing;

    try {
        const id = await context.runMutation(api.notifications.createChannel, {
            destination: body.destination,
            ...(events === undefined ? {} : { events }),
            kind: body.kind,
            name: body.name,
            organizationId: body.organizationId,
            ...(sealed === undefined ? {} : { secretCiphertext: sealed.ciphertext, secretIv: sealed.iv }),
        });

        return Response.json({ id, ...(signingKey === undefined ? {} : { signingSecret: signingKey }) });
    } catch (error) {
        return rejected(error, "create channel failed");
    }
};
