# Plan 242 — Reply-out path for triggered agent runs (design spike)

- **Category**: capability gap (inbound trigger, no outbound reply)
- **Status**: SPIKE — design + single-channel prototype only, no production wiring
- **Baseline**: `2d4f71511` (drift check passed — `channels.ts`/`inbound.ts`/`types.ts`
  unchanged since; the only diff under `packages/agent/src` is plan 240's own
  new prototype file)
- **Goal**: decide how a `defineAgent`-declared agent, triggered by an inbound
  Slack mention / GitHub comment / Discord message / email, delivers its
  answer back to the SAME thread/channel/conversation it was triggered from.
  Produce a design + a single-channel (email) prototype proving capture → run
  → threaded reply. Do **not** build the other three channels' outbound
  adapters or wire anything into `component.ts`/`agent-loop.ts`/`inbound.ts`.

## Current state (verified)

- **Inbound is fully built, outbound does not exist.** `packages/agent/src/channels.ts`
  verifies Slack (HMAC over `v0:timestamp:body`), GitHub (HMAC over the body),
  and Discord (Ed25519 over `timestamp+body`) webhook signatures
  (`verifySlack`/`verifyGithub`/`verifyDiscord`, `channels.ts:66-126`), then
  offers the parsed, verified event to each agent's `onInbound.map` mapper
  (`channels.ts:311-371`, `dispatchAgentChannel`). `packages/agent/src/inbound.ts`
  does the email equivalent: DKIM/SPF/DMARC-gated, dispatching to `onEmail`
  (`inbound.ts:67-112`, `dispatchAgentEmail`).
- **Grep confirms the gap.** `reply|respond|postMessage|sendEmail|outbound|threadTs|replyTo`
  matches nothing in `channels.ts` or `inbound.ts` — there is no code path
  from a finished run back to the channel it came from. The run's answer only
  ever lands in `agent_messages` (the live-subscription thread the mapper's
  OWN caller, if any, can read) — never posted back to Slack/GitHub/Discord,
  never emailed back.
- **The reply handle is available at map time, not dropped by verification.**
  This matters for the STOP condition this plan was written under
  ("capturing the reply reference requires re-parsing the raw inbound payload
  the verifier already consumed"). Checked directly:
  - Email: `packages/mail/src/inbound/parse.ts:65-96` (`InboundEmail`) already
    carries `messageId`, `from`, `to`, `inReplyTo`, `references` — CR/LF-checked,
    fully parsed — and the WHOLE object is handed to `AgentEmailMapper`
    (`types.ts:462`) unmodified. No re-parse is needed; the ref is one field
    read away from where the mapper already stands.
  - Channels: `InboundChannelEvent` (`types.ts:474-483`) hands the mapper
    `headers` and a `json()` accessor over the ALREADY-VERIFIED raw body
    (`channels.ts:328`, built once per request, after signature check). A
    Slack `event_callback`'s `event.channel`/`event.ts` (or `thread_ts` for a
    threaded reply), a GitHub `issue_comment`'s `repository`/`issue.number`/
    `comment.id`, and a Discord message's `channel_id`/`id` are all fields on
    that same parsed body — again, no re-parse and no signature-verification
    change required to read them.
  - **Conclusion: this STOP condition does not trigger for any of the four
    channels.** The gap is that nothing captures these fields into the
    RETURNED run shape (`AgentEmailRun`/`AgentChannelRun`,
    `types.ts:433-448`/`468`) — both are `{ input, owner?, threadKey, title? }`
    today, with no room for a reply reference. That's a type/shape gap at the
    map→run boundary, not a re-parsing problem.
- `packages/mail/src/types.ts:33-44` (`SendOptions`) already accepts arbitrary
  `headers?: Record<string, string>` on `mailer.send(...)` — so `In-Reply-To`/
  `References` threading is just two header entries, no new mail-package
  capability needed. `@lunora/mail` is already a direct dependency of
  `@lunora/agent` (`packages/agent/package.json:93`).
- `plans/README.md:627` — plan 132 ("Outbound webhook delivery on
  queue/scheduler/dispatch") spiked Standard-Webhooks-over-`SchedulerDO`
  delivery: signed, retried, dead-lettered dispatch to a table of REGISTERED
  SUBSCRIBER endpoints. That is a fan-out primitive for "notify N URLs an
  event happened," with machinery (endpoint table, redrive UX) sized for that
  problem. A reply targets exactly ONE destination the inbound event already
  named (one thread, one comment, one Message-ID) — there is no subscriber
  list, no fan-out, and (per channel) a different, provider-specific delivery
  call (Slack `chat.postMessage`, GitHub "create issue comment", `@lunora/mail`
  send) rather than a generic signed webhook POST.

## `AgentReplyRef` per channel

A discriminated union, one variant per trigger, threaded through the run
shape (not the event — the event is already fully available to the mapper;
the ref is what survives PAST the mapper, into the run and eventually to
wherever a reply is composed):

```ts
type AgentReplyRef =
    | { channel: "discord"; channelId: string; messageId?: string }
    | { channel: "email"; from: string; messageId: string; references?: string; to: string[] }
    | { channel: "github"; commentId?: number; issueNumber: number; owner: string; repo: string }
    | { channel: "slack"; channelId: string; threadTs: string };
```

- **Email** — `from`/`to` swap for the reply (reply goes back to the sender,
  from whichever mailbox received it); `messageId` becomes `In-Reply-To`;
  `references` (the inbound message's OWN `References` header, if any) plus
  its `messageId` becomes the reply's `References` — standard RFC 2822/5322
  threading, the same convention every mail client already implements.
- **Slack** — `channelId` + `threadTs` (the root message's `ts`, or the event's
  own `ts` if it's the first reply) is exactly what `chat.postMessage`'s
  `thread_ts` parameter wants.
- **GitHub** — `owner`/`repo`/`issueNumber` addresses "create a comment on this
  issue/PR"; `commentId` is carried for a possible future "reply to this
  specific review comment" (GraphQL reply-to-comment), not needed for a
  top-level issue comment.
- **Discord** — `channelId` alone posts a new channel message; a genuine
  threaded reply (Discord's `message_reference`) additionally wants the
  triggering message's `id`. See the open question below — Discord's actual
  reply mechanism doesn't fit this shape as cleanly as the other three (below).

Capture point: each channel's mapper populates `replyRef` on ITS OWN turn,
from data it already has:

- `onEmail: (email) => ({ ..., replyRef: email.messageId === undefined ? undefined : { channel: "email", from: email.from, messageId: email.messageId, references: email.references, to: email.to } })`
- `onInbound.map: (event) => { const body = event.json() as SlackEventBody; return { ..., replyRef: { channel: "slack", channelId: body.event.channel, threadTs: body.event.thread_ts ?? body.event.ts } }; }`

Both are ORDINARY application code the mapper author writes — `AgentReplyRef`
just needs to be a valid field on `AgentEmailRun`/`AgentChannelRun` for it to
type-check and flow through to wherever a reply is triggered. This plan does
not itself change `types.ts` (see Non-goals); it establishes the shape a real
change would add.

## Reply API: automatic callback, not a tool

Two shapes considered:

1. **`defineAgent({ onReply: async (result, replyRef) => {...} })`** — a new
   per-agent callback, mirroring the existing `onStepFinish` (`types.ts:609`)
   in how it's wired: invoked once, automatically, at the same point
   `agent-loop.ts`'s terminal turn persists the final assistant message and
   patches the thread status (`agent-loop.ts` — `handleTurn`'s "final answer"
   branch, `~828-870`). The run doesn't need to know or care it was
   triggered externally; `onReply` only fires when `replyRef` is present
   (i.e., the thread WAS started from an inbound trigger, not a normal
   in-app `ctx.agents.<name>.run` call).
2. **A reply tool** — give the model an explicit `reply` tool it calls
   mid-conversation (like any other tool call), so the agent can post
   more than once (a "still working on it" ack, then a final answer) or
   choose NOT to reply.

**Recommendation: (1), the automatic callback, as the default; leave (2) as a
future extension, not a competing default.** A triggered agent's whole point
is "answer where you were asked" — making that automatic is the same reasoning
that makes email threading automatic in a mail client, and it needs no prompt
engineering to make the model remember to call a tool. A tool-based path is
still worth having LATER for agents that want multiple/partial replies (open
question below), layered on top of `onReply` rather than replacing it — a tool
call can itself just invoke the same reply primitive `onReply` would use.

## Transport decision: build directly, not over plan 132

**Build a direct, per-channel outbound call — do not route through plan 132's
Standard-Webhooks-over-scheduler transport.** Same reasoning as plan 240's
workpool rejection, mirrored:

- Plan 132 solves "deliver a signed payload to N registered subscriber
  endpoints, with retry/dead-letter/redrive for a fan-out audience." A reply
  has exactly one destination, already named by the inbound event (a
  `threadTs`, a `Message-ID`, an issue number) — there is no subscriber table
  to look up and no generic payload to sign, because the destination isn't a
  registered webhook URL at all; it's a provider API call (`chat.postMessage`,
  "create comment," an outbound email).
- The four channels don't share a wire format the way plan 132's subscribers
  do (one Standard-Webhooks POST shape for everyone). Reply delivery is
  necessarily per-channel: `@lunora/mail` for email (already a dependency),
  a Slack Web API call for Slack, GitHub's REST/GraphQL API for GitHub, and
  Discord's REST API (or the interaction followup-webhook token) for Discord.
  Forcing these through a shared signed-webhook transport buys nothing; each
  needs its own SDK/fetch call and its own auth anyway.
- Retry IS still a real need (a transient Slack/GitHub/mail failure
  shouldn't silently drop the answer), but that's a much smaller ask than
  plan 132's full delivery framework — likely `step.do`'s existing at-least-
  once retry (the run is already inside a Cloudflare Workflow) is enough,
  not a new endpoint-table/dead-letter subsystem.

## Per-channel auth

- **Email — already has a home.** The reply goes out through the app's
  existing `@lunora/mail` `Mailer` (`createMailer`/`createMailerFromEnv`),
  configured once for the whole app (API key or Cloudflare Email Workers
  `send_email` binding). No new credential surface: `onReply` for an
  email-triggered run just needs a `Mailer` in scope, exactly like any other
  server-side send already in the app.
- **Slack/GitHub/Discord — no home yet; reporting the gap, not inventing a
  store.** `AgentInboundChannel` (`types.ts:501-513`) already carries an
  INBOUND `secret: string | ((env) => string | undefined)` for verifying
  signatures — but there is nothing analogous for an OUTBOUND credential (a
  Slack bot token, a GitHub App installation token, a Discord bot token).
  `ctx.secrets` (Cloudflare Secrets Store, per `@lunora/server`'s package
  description) is the obvious place such a token would eventually live, and
  an `AgentInboundChannel.replyToken` field mirroring the existing `secret`
  shape is the obvious API shape — but neither exists today, and this spike
  does not add either. This is a real gap a follow-up plan needs to close
  before Slack/GitHub/Discord replies can ship, independent of the queue/
  transport decisions above.

## Prototype (test-only, email channel)

`packages/agent/src/reply.prototype.ts` — NOT wired into `inbound.ts`,
`component.ts`, `agent-loop.ts`, or `types.ts`, and NOT exported from
`./index`:

- `EmailReplyRef` (the email variant of `AgentReplyRef` above).
- `captureEmailReplyRef(email: InboundEmail): EmailReplyRef | undefined` —
  reads `messageId`/`from`/`to`/`references` straight off the ALREADY-PARSED
  `InboundEmail` from `@lunora/mail/inbound` (no re-parsing); returns
  `undefined` when the inbound message had no `Message-ID` (nothing to thread
  against — same "can't queue an id-less run" honesty pattern as plan 240's
  overflow case).
- `replyToEmail(mailer, replyRef, body)` — sends via the REAL `Mailer` contract
  from `@lunora/mail` (`mailer.send(...)`), addressed back to `replyRef.from`,
  with `headers: { "In-Reply-To": replyRef.messageId, References: <references
  + messageId, space-joined> }` — standard RFC 5322 threading.

`packages/agent/__tests__/reply.prototype.test.ts` builds a fake `MailTransport`
(records what it was asked to send, matching the pattern `component.test.ts`'s
`fakeAgents()` already uses for recording calls) and a REAL `createMailer`
from `@lunora/mail` on top of it — proving the prototype's payload passes the
package's actual address/header validation, not just a hand-rolled assertion.
The test drives: capture a ref from a synthetic inbound email (with a prior
`References` header, so the round-trip must APPEND rather than replace) → "run"
the agent (a stub answer string, standing in for `runAgentLoop`'s real output)
→ reply → assert the fake transport recorded a message `to` the original
sender, `In-Reply-To` the original `Message-ID`, `References` containing BOTH
the prior chain and the original id, and the run's answer as the body. A
second case proves a message with NO `Message-ID` yields `undefined` (declines
to reply) rather than sending an unthreaded reply.

`channels.ts`/`inbound.ts` are untouched by this plan — running the full
`@lunora/agent` suite (which includes the existing Slack/GitHub/Discord
signature-verification tests) is itself the proof inbound verification is
unaffected.

## Open questions (unresolved by this spike)

1. **`AgentReplyRef` as a real field.** This spike defines the shape but does
   not add it to `AgentEmailRun`/`AgentChannelRun`/`InboundChannelEvent` in
   `types.ts` — a real change needs to decide whether `AgentChannelRun`
   (today `= AgentEmailRun`, `types.ts:468`) keeps that type alias (forcing
   `AgentReplyRef` to be one union covering all channels, as drafted above) or
   diverges into its own type now that channels and email need different
   reply shapes.
2. **Per-channel outbound token storage.** Reported above as a gap, not
   designed here: Slack/GitHub/Discord need a credential surface on
   `AgentInboundChannel` (or elsewhere) that doesn't exist yet.
3. **Automatic vs. explicit reply.** The recommended `onReply` callback fires
   once, automatically, on the final answer. Does any real use case need
   multiple replies (an early ack, a follow-up), and if so is that a SECOND
   automatic hook, or the tool-based path noted above layered on top?
4. **Partial-failure behavior.** The run succeeds and persists its answer to
   the thread, but the reply POST/send fails (rate limit, revoked token,
   transient network). Today's `agentAppendMessage`/thread state has no
   "answered but couldn't tell them" status — does this need a new
   `AgentThreadStatus` value, a retry (and if so, how many/how durable — see
   the transport decision above), or is "the answer is safely in the thread,
   the reply is best-effort" an acceptable default?
5. **Discord's reply mechanism doesn't fit the shared shape.** Slack/GitHub/
   email all reply via a persistent bot/API token to a durable
   channel/issue/mailbox address. Discord INTERACTIONS (the inbound trigger
   `channels.ts` verifies) instead hand back a time-limited followup-webhook
   token scoped to that one interaction — a different, narrower credential
   than "a bot token that can post to any channel." Whether Discord reply
   support uses that followup-webhook token (simpler auth, but expires) or a
   full bot token (persistent, but a bigger credential to provision) is
   unresolved and may need its own mini-spike.

## Non-goals (this spike)

- Adding `AgentReplyRef`/`onReply`/`replyToken` to `types.ts`, or wiring
  `onReply` into `agent-loop.ts`'s terminal-turn handling.
- Slack, GitHub, or Discord outbound adapters (only email is prototyped).
- Any token/secret storage productization (`ctx.secrets` wiring, a new
  `AgentInboundChannel` field).
- Changing `channels.ts`'s or `inbound.ts`'s verification logic.
- The durable run queue (plan 240) — unrelated surface.
