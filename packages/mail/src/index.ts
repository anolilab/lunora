// For a host that queues mail itself (`@lunora/platform-node`), so it refuses at enqueue exactly the keys the consumer would.
export { assertValidIdempotencyKey } from "./address";
export type { CapturedMail, MailboxSink } from "./capture-transport";
export { createCaptureTransport } from "./capture-transport";
export type { CloudflareSend, CloudflareTransportOptions } from "./cloudflare-transport";
export { createCloudflareTransport } from "./cloudflare-transport";
export { default as createMailer } from "./create-mailer";
export type { FromEnvOptions, MailEnv } from "./from-env";
export { createCaptureSink, createMailerFromEnv, shouldCaptureMail } from "./from-env";
export type { ConsumeQueuedSendOptions, QueuedSend, SentMailStore } from "./queue";
export { consumeQueuedSend, toQueuedPayload } from "./queue";
export { default as renderEmail } from "./render";
export { default as createResendTransport } from "./resend-transport";
export type { MailSendErrorData } from "./send-error";
export { isOutcomeUnknownMailError, isRetryableMailError, MailSendError } from "./send-error";
export type { LunoraMailOptions, Mailer, MailTransport, QueueLike, SendOptions, SendPayload } from "./types";
