package lunora

// With no identity set, the bearer token's digest is who a queued write belongs
// to. Every write goes through Submit — the path that stamps it — and every
// flush is the caller's own, so nothing here depends on a socket.

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func setToken(client *Client, token string) { client.SetAuthToken(token) }

// tokenClient queues one write under token with no identity set, recording the
// authorization header of every request and every settled event.
func tokenClient(t *testing.T, token string) (*Client, *[]string, *[]MutationSettled) {
	t.Helper()

	headers := &[]string{}
	client := NewClient("https://app.example", func(_ string, sent map[string]string, _ []byte) (int, []byte, error) {
		*headers = append(*headers, sent["authorization"])

		return 200, []byte(`{"result":null}`), nil
	})
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{QueueBeforeFirstConnect: true}))
	setToken(client, token)

	settled := &[]MutationSettled{}
	client.OnMutationSettled(func(event MutationSettled) { *settled = append(*settled, event) })

	if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	if client.PendingMutationCount() != 1 {
		t.Fatalf("the write was not queued")
	}

	return client, headers, settled
}

func offlineCode(event MutationSettled) string {
	var offline OfflineError
	if errors.As(event.Err, &offline) {
		return offline.Code
	}

	return ""
}

func TestAWriteQueuedUnderOneTokenNeverTravelsWithAnother(t *testing.T) {
	client, headers, settled := tokenClient(t, "token-a")
	setToken(client, "token-b")

	report := client.FlushOfflineQueue("")

	if len(*headers) != 0 {
		t.Fatalf("user A's write was sent with user B's bearer: %v", *headers)
	}

	code, _ := fixtureScenario(t, "offlineQueue", "identityGate")["code"].(string)
	if len(*settled) != 1 || offlineCode((*settled)[0]) != code || !reflect.DeepEqual(report.Rejected, []string{(*settled)[0].MutationID}) {
		t.Fatalf("want one %s rejection, got %+v (report %+v)", code, *settled, report)
	}

	if client.PendingMutationCount() != 0 {
		t.Fatalf("the rejected write is still queued")
	}
}

func TestAWriteReplaysUnderTheTokenItWasQueuedWith(t *testing.T) {
	client, headers, settled := tokenClient(t, "token-a")

	report := client.FlushOfflineQueue("")

	if !reflect.DeepEqual(*headers, []string{"Bearer token-a"}) || len(report.Committed) != 1 || (*settled)[0].Status != MutationCommitted {
		t.Fatalf("headers %v, report %+v, settled %+v", *headers, report, *settled)
	}
}

func TestAWriteQueuedWithNoTokenReplaysWithNone(t *testing.T) {
	client, headers, _ := tokenClient(t, "")

	report := client.FlushOfflineQueue("")

	if !reflect.DeepEqual(*headers, []string{""}) || len(report.Committed) != 1 {
		t.Fatalf("headers %v, report %+v", *headers, report)
	}
}

// Nobody is signed in, so whose write it is cannot be told: held, neither sent
// nor dropped, as the reference's "unknown" verdict holds it.
func TestAWriteQueuedUnderATokenIsHeldOnceTheTokenIsCleared(t *testing.T) {
	client, headers, settled := tokenClient(t, "token-a")
	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store, QueueBeforeFirstConnect: true}))

	if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send", MutationID: "m2"}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	setToken(client, "")

	report := client.FlushOfflineQueue("")

	if len(*headers) != 0 || len(*settled) != 0 || len(report.Rejected) != 0 || len(report.Committed) != 0 {
		t.Fatalf("a held write was settled or sent: headers %v, settled %+v, report %+v", *headers, *settled, report)
	}

	if client.PendingMutationCount() != 1 || len(store.records) != 1 || len(store.removed) != 0 {
		t.Fatalf("the held write must stay queued and persisted: pending %d, records %v", client.PendingMutationCount(), store.records)
	}

	setToken(client, "token-a")
	client.FlushOfflineQueue("")

	if !reflect.DeepEqual(*headers, []string{"Bearer token-a"}) {
		t.Fatalf("headers after the token is back: %v", *headers)
	}
}

// The gate judged the pass against token-a, so every request in that pass —
// each batch chunk and each half of a 413 split — carries token-a.
func TestATokenSwitchedMidFlushDoesNotCarryTheRestOfIt(t *testing.T) {
	var client *Client

	type sent struct {
		bearer string
		calls  int
	}

	var posts []sent

	split := true

	client = NewClient("https://app.example", func(_ string, headers map[string]string, body []byte) (int, []byte, error) {
		var parsed map[string]any
		_ = json.Unmarshal(body, &parsed)
		calls, _ := parsed["calls"].([]any)
		posts = append(posts, sent{headers["authorization"], len(calls)})
		setToken(client, "token-b")

		// The first request is refused for size, so the first chunk splits.
		if split {
			split = false

			return 413, []byte(`{"error":{"code":"PAYLOAD_TOO_LARGE","message":"too big"}}`), nil
		}

		slots := make([]string, 0, len(calls))
		for index := range calls {
			slots = append(slots, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":1,"result":null}}`, index))
		}

		return 200, []byte(`{"results":[` + strings.Join(slots, ",") + `]}`), nil
	})
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{MaxItems: MaxBatchEntries + 1, QueueBeforeFirstConnect: true}))
	setToken(client, "token-a")

	for range MaxBatchEntries + 1 {
		if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}

	report := client.FlushOfflineQueue("")

	half := MaxBatchEntries / 2
	want := []sent{{"Bearer token-a", MaxBatchEntries}, {"Bearer token-a", half}, {"Bearer token-a", MaxBatchEntries - half}, {"Bearer token-a", 1}}

	if !reflect.DeepEqual(posts, want) || len(report.Committed) != MaxBatchEntries+1 {
		t.Fatalf("posts %v, want %v (committed %d)", posts, want, len(report.Committed))
	}
}

// Before token digests a write queued with no identity was stamped signed-out
// whatever token was held, so that stamp no longer says whose it is: signed in,
// it is a mismatch, as a null stamp is in the reference.
func TestARecordStampedSignedOutByAnEarlierBuildIsNotSentUnderAToken(t *testing.T) {
	var posts int

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		posts++

		return 200, []byte(`{"result":null}`), nil
	})
	setToken(client, "token-b")
	client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: "m1", Identity: SignedOut()})

	report := client.FlushOfflineQueue("")

	if posts != 0 || !reflect.DeepEqual(report.Rejected, []string{"m1"}) {
		t.Fatalf("posts %d, report %+v", posts, report)
	}
}

// With no identity the token's digest is the identity, so a token change is a
// change of user for the session as it is for the queue. Only a change FROM a
// token evicts, as only a change from a set identity does.
func TestANewTokenWithoutAnIdentityEvictsThePreviousSession(t *testing.T) {
	block, _ := loadFixture(t, "ws-frames.json")["identityChange"].(map[string]any)
	sequence, _ := shapeFixture(t)["pokeSequence"].([]any)

	transitions := []struct {
		before, after, identity string
		evicts                  bool
	}{
		{"token-a", "token-b", "", true},
		{"token-a", "", "", true},
		{"token-a", "token-a", "", false},
		{"", "token-a", "", false},
		{"token-a", "token-b", "user-a", false},
	}

	for _, transition := range transitions {
		t.Run(fmt.Sprintf("%q->%q as %q", transition.before, transition.after, transition.identity), func(t *testing.T) {
			client := NewClient("https://app.example", nil)
			setToken(client, transition.before)

			if transition.identity != "" {
				client.SetIdentity(&transition.identity)
			}

			client.AttachSocket(func(map[string]any) error { return nil })
			client.Subscribe("messages:list", map[string]any{}, func(any) {}, nil, "")
			client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func([]any) {}, nil)
			deliverAll(t, client, []any{block["queryFrame"]})
			deliverAll(t, client, sequence)

			setToken(client, transition.after)

			resent := resendFrames(t, client)
			query, _ := resent[0]["query"].(map[string]any)

			client.mu.Lock()
			rowCount := len(client.shapes["shape_1"].rows)
			client.mu.Unlock()

			_, hasSeq := query["sinceSeq"]
			_, hasCheckpoint := resent[1]["sinceCheckpoint"]

			if hasSeq == transition.evicts || hasCheckpoint == transition.evicts || (rowCount == 0) != transition.evicts {
				t.Fatalf("evicts=%v but sinceSeq present %v, sinceCheckpoint present %v, rows %d", transition.evicts, hasSeq, hasCheckpoint, rowCount)
			}
		})
	}
}

// The digest vectors are the reference client's, read from the shared fixture
// every port asserts, and the account switch is the one that fixture names.
func TestAnUnsetIdentityStampsTheTokenDigest(t *testing.T) {
	covers("offline_unset_identity_stamps_token_digest")

	scenario := fixtureScenario(t, "offlineQueue", "tokenIdentity")
	digests, _ := scenario["digests"].([]any)

	if len(digests) == 0 {
		t.Fatal("tokenIdentity has no digests")
	}

	for _, raw := range digests {
		spec, _ := raw.(map[string]any)
		token, _ := spec["token"].(string)

		if got := TokenDigest(token); got != spec["digest"] {
			t.Fatalf("TokenDigest(%q) = %s, want %v", token, got, spec["digest"])
		}
	}

	accountSwitch, _ := scenario["accountSwitch"].(map[string]any)
	queuedUnder, _ := accountSwitch["queuedUnder"].(string)
	flushedUnder, _ := accountSwitch["flushedUnder"].(string)
	code, _ := fixtureScenario(t, "offlineQueue", "identityGate")["code"].(string)

	client, headers, settled := tokenClient(t, queuedUnder)
	setToken(client, flushedUnder)

	report := client.FlushOfflineQueue("")

	if len(*headers) != 0 || len(report.Rejected) != 1 || len(*settled) != 1 || offlineCode((*settled)[0]) != code {
		t.Fatalf("account switch: headers %v, report %+v, settled %+v", *headers, report, *settled)
	}

	client, headers, settled = tokenClient(t, queuedUnder)

	report = client.FlushOfflineQueue("")

	if !reflect.DeepEqual(*headers, []string{"Bearer " + queuedUnder}) || len(report.Committed) != 1 || (*settled)[0].Status != MutationCommitted {
		t.Fatalf("same token: headers %v, report %+v, settled %+v", *headers, report, *settled)
	}
}

// A token write is stamped as a token digest, an identity as itself, so neither
// can be taken for the other however the identity is spelled.
func TestAnIdentitySpelledLikeADigestNeverMatchesThatTokensWrites(t *testing.T) {
	digest := TokenDigest("token-a")

	flushAfter := func(queueIdentity, queueToken, replayIdentity, replayToken string) int {
		var posts int

		client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
			posts++

			return 200, []byte(`{"result":null}`), nil
		})
		client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{QueueBeforeFirstConnect: true}))

		apply := func(identity, token string) {
			if identity == "" {
				client.SetIdentity(nil)
			} else {
				client.SetIdentity(&identity)
			}

			client.SetAuthToken(token)
		}

		apply(queueIdentity, queueToken)

		if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
			t.Fatalf("submit: %v", err)
		}

		apply(replayIdentity, replayToken)
		client.FlushOfflineQueue("")

		return posts
	}

	if posts := flushAfter("", "token-a", digest, ""); posts != 0 {
		t.Fatalf("a token write replayed under an identity spelled as its digest")
	}

	if posts := flushAfter(digest, "", "", "token-a"); posts != 0 {
		t.Fatalf("an identity write replayed under the token its spelling digests")
	}

	if got := ReplayIdentityVerdict(Identity{Present: true, TokenDigest: digest}, IdentityOf(digest), ""); got != ReplayMismatch {
		t.Fatalf("token stamp vs digest-spelled identity: %s", got)
	}

	if got := ReplayIdentityVerdict(IdentityOf(digest), TokenStamp("token-a"), "token-a"); got != ReplayMismatch {
		t.Fatalf("digest-spelled identity vs token stamp: %s", got)
	}
}

func TestATokenStampSurvivesPersistence(t *testing.T) {
	store := &memoryStore{}
	client := NewClient("https://app.example", nil)
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store, QueueBeforeFirstConnect: true}))
	client.SetAuthToken("token-a")

	if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	stamp := TokenStamp("token-a")
	if got := client.OfflineQueue().Items()[0].Identity; !got.Equal(stamp) {
		t.Fatalf("stamped %+v, want %+v", got, stamp)
	}

	// memoryStore round-trips every record through JSON, as a real adapter does.
	if got, want := canonical(t, store.records[0]["identity"]), canonical(t, map[string]any{"tokenDigest": TokenDigest("token-a")}); got != want {
		t.Fatalf("persisted identity %s, want %s", got, want)
	}

	restored, err := mutationFromRecord(roundTrip(store.records[0]))
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	if !restored.Identity.Equal(stamp) || ReplayIdentityVerdict(restored.Identity, stamp, "token-a") != ReplayMatch {
		t.Fatalf("restored %+v", restored.Identity)
	}
}

func TestSubjectAndSignedOutStampsAreJudgedAsBefore(t *testing.T) {
	cases := []struct {
		stamped, current Identity
		token            string
		verdict          ReplayVerdict
	}{
		{IdentityOf("user-a"), IdentityOf("user-a"), "", ReplayMatch},
		{IdentityOf("user-a"), IdentityOf("user-b"), "", ReplayMismatch},
		{IdentityOf("user-a"), SignedOut(), "", ReplayUnknown},
		{SignedOut(), SignedOut(), "", ReplayMatch},
		{SignedOut(), IdentityOf("user-a"), "", ReplayMismatch},
		{SignedOut(), TokenStamp("token-b"), "token-b", ReplayMismatch},
		{AbsentIdentity(), IdentityOf("user-a"), "", ReplayMatch},
		{AbsentIdentity(), TokenStamp("token-b"), "token-b", ReplayMatch},
		// A write queued under a token stays that token's after an identity is named.
		{TokenStamp("token-a"), IdentityOf("user-a"), "token-a", ReplayMatch},
		{TokenStamp("token-a"), IdentityOf("user-a"), "token-b", ReplayMismatch},
	}

	for index, spec := range cases {
		if got := ReplayIdentityVerdict(spec.stamped, spec.current, spec.token); got != spec.verdict {
			t.Fatalf("case %d: %s, want %s", index, got, spec.verdict)
		}
	}
}
