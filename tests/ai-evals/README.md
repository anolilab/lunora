# @lunora/ai-evals-tests

The behavioural eval set for the Studio's AI assistant engine
(`shared/ai-chat.ts`), scored with `@lunora/testing`'s `evaluate` and scorers.

## Why it lives here rather than in a package

The suite spans two things that belong to nobody: the engine in the root
`shared/` folder (inlined into `@lunora/runtime`, not a package) and the
`@lunora/testing` toolkit that scores it. Putting it in `packages/runtime`
would need a `@lunora/runtime` → `@lunora/testing` devDependency, and that is a
build **cycle** — `@lunora/testing` reaches `@lunora/runtime` back through
`@lunora/agent` → `@lunora/mail` → `@lunora/react` → `@lunora/client`. Nothing
depends on `tests/*`, so here it is just a consumer of both.

## What it measures

The model is scripted — `AiRunBinding` is a one-method structural projection —
so the suite is deterministic and needs no Cloudflare account and no token.
That rules out grading the model, deliberately: scoring a scripted reply would
only score the fixture. What is left is the half we own, and what every case is
about — prompt assembly and grounding, the data-sharing ladder, tool selection
and dispatch, refusal handling, the untrusted fence, the transcript budget, and
the degrade-don't-throw contract.

Judging the model's actual answer quality needs a live model and a judge, so it
is out of scope on purpose: a CI gate that needs an API token is a gate that
gets disabled.

## Running it

```bash
pnpm --filter "@lunora/ai-evals-tests" run test
```

Every case must score 1 — each is a behavioural invariant, not a quality
judgement, so there is no partial credit to allow for. A failure names the
behaviour and prints the scorers that decided it.

## Why `lunora eval` cannot run this yet

`ai-chat.eval.ts` is deliberately shaped as `lunora eval`'s `EvalModule` (a lone
default export of `{ name, run, threshold }`), but
`lunora eval --dir tests/ai-evals` fails to load it, and would fail on any eval
file in this repo or in a Lunora app that imports project source:

- The command loads a discovered `*.eval.ts` with a bare `import()`.
- Node's native TypeScript execution resolves no extensions, and every module
  here compiles under `moduleResolution: "bundler"` and therefore writes
  extension-less relative imports, per the house style.

So the import fails one hop in, at `shared/ai-chat`'s own `./sql-readonly`.
Closing that needs the TS loader/transform the command's handler already flags
as deferred (`plans/245-eval-runner-design.md` §8.3). When it lands, this file
runs there unchanged; until then the vitest gate is the runner.

## Why the results are not in the Studio's Evals panel

That panel reads `gen_ai.evaluation.*` off a live shard's trace ring and metric
buckets — it shows what `recordEvaluation` scored on a running deployment. This
suite runs in Node against a scripted model and has no shard, and giving it one
would mean an admin op that writes arbitrary eval scores into a deployment's
telemetry: a fabrication surface, in exchange for a table CI already prints.
