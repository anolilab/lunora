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

## The other runner

`ai-chat.eval.ts` is shaped as `lunora eval`'s `EvalModule` (a lone default
export of `{ name, run, threshold }`), so the same file runs both ways:

```bash
lunora eval --dir tests/ai-evals
```

That used to fail. The command loaded a discovered `*.eval.ts` with a bare
`import()`, and Node's native TypeScript execution strips types but resolves no
extensions — while every module here, and every file in a scaffolded Lunora
app, compiles under `moduleResolution: "bundler"` and therefore writes
extension-less relative imports. The load died one hop in, at `shared/ai-chat`'s
own `./sql-readonly`. The command now loads eval files through a runtime TS
loader, so an eval that imports project source resolves.

`__tests__/lunora-eval-cli.test.ts` is what keeps it that way, and it shells out
to the built binary deliberately: Vitest resolves and transforms whatever it is
handed, so an in-process test of the runner passes whether or not the shipped
command can load anything.

## Why the results are not in the Studio's Evals panel

That panel reads `gen_ai.evaluation.*` off a live shard's trace ring and metric
buckets — it shows what `recordEvaluation` scored on a running deployment. This
suite runs in Node against a scripted model and has no shard, and giving it one
would mean an admin op that writes arbitrary eval scores into a deployment's
telemetry: a fabrication surface, in exchange for a table CI already prints.
