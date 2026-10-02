# @lunora-example/services

A Lunora app that calls two sibling Cloudflare Workers over service bindings
(plan 457): a fetch service and a `WorkerEntrypoint` RPC service.

## What it demonstrates

- `lunora.config.ts` `services`: each entry points at a Worker folder with its
  own `wrangler.jsonc`
- A typed `ctx.services.<key>` in an action (`lunora/documents.ts`): the RPC
  method is typed from the `Gateway` class, and the fetch service's `fetch` can
  be handed to a client detached
- `vite dev` running both services as auxiliary Workers in the same session,
  and reconcile writing the `services[]` bindings into `wrangler.jsonc`

## Run it

```bash
pnpm install
pnpm --filter @lunora-example/services dev
curl -X POST http://localhost:5173/_lunora/rpc \
  -H 'content-type: application/json' \
  -d '{"functionPath":"documents:summarise","args":{"prompt":"hi"}}'
# {"result":{"completed":"completed hi","parsed":"/documents/7"}}
```

`lunora deploy` deploys `services/parser` and `services/gateway` first, then
the app. See [Services](https://lunora.sh/docs/concepts/services).
