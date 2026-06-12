/**
 * Ambient stub for the `cloudflare:email` module so the `mail` registry item
 * (which builds an RFC 822 message for the Worker `send_email` binding)
 * type-checks standalone under `registry/tsconfig.json` (which ships only
 * `types: ["node"]`). In a real Cirrus project `@cloudflare/workers-types`
 * provides the precise `cloudflare:email` types and supersedes this shim.
 */
declare module "cloudflare:email" {
    export class EmailMessage {
        constructor(from: string, to: string, raw: ReadableStream | string);
        readonly from: string;
        readonly raw: ReadableStream | string;
        readonly to: string;
    }
}
