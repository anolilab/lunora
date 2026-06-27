import type { PipelineBindingLike, PipelineClient, PipelineRecord } from "./types";

/**
 * Wrap a Cloudflare Pipelines binding in the write-side {@link PipelineClient}
 * bound to `ctx.pipelines`. The binding is `env.PIPELINES` (the `pipelines`
 * binding the config layer recognizes; the remote pipeline name is minted with
 * `wrangler pipelines create`).
 *
 * Ingestion is durable and batched: `send` accepts one record or an array and
 * resolves once Cloudflare has accepted them for delivery to the R2-backed sink.
 * There is no in-handler read-back — this is a fire-and-forget egress path, so
 * it belongs on ActionCtx only (external I/O), mirroring `ctx.images`.
 */
// eslint-disable-next-line import/prefer-default-export -- re-exported as a named export from index.ts; the package convention is named-only exports
export const createPipelines = <T extends PipelineRecord = PipelineRecord>(options: { binding: PipelineBindingLike<T> }): PipelineClient<T> => {
    const { binding } = options;

    return {
        send: async (records: T | T[]): Promise<void> => {
            // The Cloudflare binding requires an array, even for a single record.
            await binding.send(Array.isArray(records) ? records : [records]);
        },
    };
};
