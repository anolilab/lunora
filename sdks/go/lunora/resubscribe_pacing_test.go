package lunora

// A reconnect re-sends its query subscriptions a few at a time, as the reference client does.
// RESUBSCRIBE_CONCURRENCY in packages/client/src/client-tuning.ts is the width: a re-sent
// subscribe holds a slot until any frame bearing its id arrives, it is unsubscribed, or
// ResubscribeAckTimeout passes with no reply.

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

const pacedSubscriptions = 7

// subscribeIDs lists the ids of the subscribe frames in sent, in order.
func subscribeIDs(sent []map[string]any) []string {
	ids := []string{}

	for _, frame := range sent {
		if frame["type"] == "subscribe" {
			id, _ := frame["id"].(string)
			ids = append(ids, id)
		}
	}

	return ids
}

func ackFrame(id string) []byte { return []byte(fmt.Sprintf(`{"id":%q,"type":"ack"}`, id)) }

func handle(t *testing.T, client *Client, raw []byte) {
	t.Helper()

	if _, err := client.HandleFrame(raw); err != nil {
		t.Fatalf("HandleFrame(%s): %v", raw, err)
	}
}

func recordTo(sent *[]map[string]any) FrameSender {
	return func(frame map[string]any) error {
		*sent = append(*sent, frame)

		return nil
	}
}

func subscribeChannel(client *Client, index int) Unsubscribe {
	return client.Subscribe("messages:list", map[string]any{"channel": fmt.Sprintf("c%d", index)}, func(any) {}, nil, "")
}

// pacedClient holds count query subscriptions made on a first socket and is attached to a
// second one, before any resend.
func pacedClient(count int, sender FrameSender) (*Client, []Unsubscribe) {
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil }, nil)

	unsubscribes := make([]Unsubscribe, 0, count)
	for index := 0; index < count; index++ {
		unsubscribes = append(unsubscribes, subscribeChannel(client, index))
	}

	client.AttachSocket(sender, nil)

	return client, unsubscribes
}

// reconnected is pacedClient recording to sent, resent.
func reconnected(t *testing.T, count int, sent *[]map[string]any) *Client {
	t.Helper()

	client, _ := pacedClient(count, recordTo(sent))
	*sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	return client
}

func contains(ids []string, id string) bool {
	for _, each := range ids {
		if each == id {
			return true
		}
	}

	return false
}

func TestResubscribePacingOnlyTheWindowGoesOutUntilAReplyArrives(t *testing.T) {
	if ResubscribeConcurrency != 3 {
		t.Fatalf("the window is the reference client's 3, got %d", ResubscribeConcurrency)
	}

	var sent []map[string]any

	reconnected(t, pacedSubscriptions, &sent)

	if got := len(subscribeIDs(sent)); got != ResubscribeConcurrency {
		t.Fatalf("a resend sends only the window until a reply arrives, got %d", got)
	}
}

func TestResubscribePacingAnyFrameBearingTheIDLetsTheNextOneOut(t *testing.T) {
	var sent []map[string]any

	client := reconnected(t, pacedSubscriptions, &sent)
	window := subscribeIDs(sent)

	handle(t, client, ackFrame(window[0]))

	if got := len(subscribeIDs(sent)); got != 4 {
		t.Fatalf("an ack frees its slot: got %d subscribes, want 4", got)
	}

	handle(t, client, []byte(fmt.Sprintf(`{"cursor":1,"data":[],"id":%q,"type":"data"}`, window[1])))

	if got := len(subscribeIDs(sent)); got != 5 {
		t.Fatalf("a data frame that overtakes the ack frees it too: got %d, want 5", got)
	}

	handle(t, client, []byte(fmt.Sprintf(`{"error":{"code":"FORBIDDEN","message":"no"},"id":%q,"type":"error"}`, window[2])))

	if got := len(subscribeIDs(sent)); got != 6 {
		t.Fatalf("so does the error that refuses it: got %d, want 6", got)
	}

	handle(t, client, ackFrame(window[0]))

	if got := len(subscribeIDs(sent)); got != 6 {
		t.Fatalf("a second frame for a released id frees nothing: got %d, want 6", got)
	}
}

func TestResubscribePacingEverySubscriptionGoesOutExactlyOnceInSubscribeOrder(t *testing.T) {
	var sent []map[string]any

	client := reconnected(t, pacedSubscriptions, &sent)

	for answered := 0; answered < len(subscribeIDs(sent)); answered++ {
		handle(t, client, ackFrame(subscribeIDs(sent)[answered]))
	}

	ids := subscribeIDs(sent)
	want := make([]string, 0, pacedSubscriptions)

	for index := 1; index <= pacedSubscriptions; index++ {
		want = append(want, fmt.Sprintf("sub_%d", index))
	}

	// Go's map order is random, so only an explicit order gives the reference client's.
	if fmt.Sprint(ids) != fmt.Sprint(want) {
		t.Fatalf("every subscription goes out once, in subscribe order: got %v, want %v", ids, want)
	}
}

func TestResubscribePacingAnUnsubscribeSkipsAQueuedOneAndFreesAnOutstandingOne(t *testing.T) {
	var sent []map[string]any

	client, unsubscribes := pacedClient(5, recordTo(&sent))
	sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	outstanding := subscribeIDs(sent)

	unsubscribes[4]()

	if got := len(subscribeIDs(sent)); got != 3 {
		t.Fatalf("a queued one is dropped and frees no slot: got %d, want 3", got)
	}

	unsubscribes[0]()

	if got := len(subscribeIDs(sent)); got != 4 {
		t.Fatalf("an outstanding one will never be answered, so its slot goes on: got %d, want 4", got)
	}

	if contains(subscribeIDs(sent), "sub_5") {
		t.Fatal("the unsubscribed queued one must not go out")
	}

	handle(t, client, ackFrame(outstanding[1]))

	if got := len(subscribeIDs(sent)); got != 4 {
		t.Fatalf("nothing is left to send: got %d, want 4", got)
	}
}

func TestResubscribePacingAnUnansweredOneStopsHoldingItsSlotAfterTheTimeout(t *testing.T) {
	var sent []map[string]any

	before := time.Now()
	client := reconnected(t, pacedSubscriptions, &sent)
	after := time.Now()

	deadline, ok := client.NextSubscriptionRetryAt()
	if !ok {
		t.Fatal("an outstanding re-subscribe reports its deadline")
	}

	if deadline.Before(before.Add(ResubscribeAckTimeout)) || deadline.After(after.Add(ResubscribeAckTimeout)) {
		t.Fatalf("the deadline is the ack timeout after the resend, got %v", deadline)
	}

	if n, err := client.RetryDueSubscriptions(deadline.Add(-time.Millisecond)); err != nil || n != 0 || len(subscribeIDs(sent)) != 3 {
		t.Fatalf("a slot holds until its deadline: n=%d err=%v subscribes=%d", n, err, len(subscribeIDs(sent)))
	}

	n, err := client.RetryDueSubscriptions(deadline)
	if err != nil || n != ResubscribeConcurrency {
		t.Fatalf("every timed-out slot lets the next one out, and counts it: n=%d err=%v", n, err)
	}

	if got := len(subscribeIDs(sent)); got != 6 {
		t.Fatalf("the next window went out: got %d, want 6", got)
	}
}

func TestResubscribePacingAReconnectMidDrainStartsAFreshWindow(t *testing.T) {
	var sent []map[string]any

	client := reconnected(t, pacedSubscriptions, &sent)
	client.DetachSocket(0, "")

	if _, ok := client.NextSubscriptionRetryAt(); ok {
		t.Fatal("a dropped socket's slots are gone")
	}

	var resent []map[string]any

	client.AttachSocket(recordTo(&resent), nil)
	resent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	if got := len(subscribeIDs(resent)); got != ResubscribeConcurrency {
		t.Fatalf("the new socket gets a fresh window: got %d", got)
	}

	handle(t, client, ackFrame(subscribeIDs(sent)[0]))

	if got := len(subscribeIDs(resent)); got != 4 {
		t.Fatalf("a reply on the new socket drains its queue: got %d, want 4", got)
	}
}

func TestResubscribePacingAQueuedOneCarriesTheCursorItHasWhenItGoesOut(t *testing.T) {
	alice, bob := "alice", "bob"
	client := NewClient("https://app.example", nil)

	client.SetIdentity(&alice)
	client.AttachSocket(func(map[string]any) error { return nil }, nil)

	for index := 0; index < 4; index++ {
		subscribeChannel(client, index)
		handle(t, client, []byte(fmt.Sprintf(`{"cursor":9,"data":[],"id":"sub_%d","type":"data"}`, index+1)))
	}

	var sent []map[string]any

	client.AttachSocket(recordTo(&sent), nil)
	sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	client.SetIdentity(&bob)
	handle(t, client, ackFrame("sub_1"))

	var late map[string]any

	for _, frame := range sent {
		if frame["type"] == "subscribe" && frame["id"] == "sub_4" {
			late = frame
		}
	}

	if late == nil {
		t.Fatal("the queued subscription goes out once a slot frees")
	}

	if _, resumed := late["query"].(map[string]any)["sinceSeq"]; resumed {
		t.Fatalf("the new identity must not resume the old one's position, got %v", late)
	}
}

func TestResubscribePacingAFailedPacedSendFromAFrameIsNotTheFrameHandlersError(t *testing.T) {
	failing := false

	client, _ := pacedClient(4, func(frame map[string]any) error {
		if failing && frame["type"] == "subscribe" {
			return errors.New("socket write failed")
		}

		return nil
	})

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	failing = true

	if _, err := client.HandleFrame(ackFrame("sub_1")); err != nil {
		t.Fatalf("a paced send that fails must not end the read loop: %v", err)
	}
}

func TestResubscribePacingAFailedSendPutsTheUnsentOnesBackInLine(t *testing.T) {
	var sent []map[string]any

	broken := true
	client, _ := pacedClient(pacedSubscriptions, func(frame map[string]any) error {
		if frame["id"] == "sub_2" && broken {
			broken = false

			return errors.New("write failed")
		}

		sent = append(sent, frame)

		return nil
	})
	sent = nil

	if err := client.ResendSubscriptions(); err == nil {
		t.Fatal("the caller's own resend reports the failed write")
	}

	for answered := 0; answered < len(subscribeIDs(sent)); answered++ {
		handle(t, client, ackFrame(subscribeIDs(sent)[answered]))
	}

	seen := map[string]bool{}
	for _, id := range subscribeIDs(sent) {
		seen[id] = true
	}

	if len(seen) != pacedSubscriptions {
		t.Fatalf("every subscription still goes out after a failed write, got %v", subscribeIDs(sent))
	}
}

func TestResubscribePacingAFailedUnsubscribeWriteStillSendsTheBatchItFreed(t *testing.T) {
	var sent []map[string]any

	client, unsubscribes := pacedClient(5, func(frame map[string]any) error {
		if frame["type"] == "unsubscribe" {
			return errors.New("write failed")
		}

		sent = append(sent, frame)

		return nil
	})
	sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	unsubscribes[0]()

	if !contains(subscribeIDs(sent), "sub_4") {
		t.Fatalf("the batch a failed unsubscribe freed still goes out, got %v", subscribeIDs(sent))
	}
}

func TestResubscribePacingARetryAcrossASocketSwapLeavesTheNewQueueAlone(t *testing.T) {
	var old, fresh []map[string]any

	swapped := false

	var client *Client

	client, _ = pacedClient(5, func(frame map[string]any) error {
		old = append(old, frame)

		// The socket is replaced while the retry's own frame is being written to the old one.
		if frame["id"] == "sub_5" && !swapped {
			swapped = true

			client.DetachSocket(0, "")
			client.AttachSocket(recordTo(&fresh), nil)

			if err := client.ResendSubscriptions(); err != nil {
				t.Error(err)
			}
		}

		return nil
	})

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	handle(t, client, []byte(`{"error":{"code":"OVERLOADED","message":"busy","retryAfterMs":0},"id":"sub_5","type":"error"}`))

	if _, err := client.RetryDueSubscriptions(time.Now().Add(2 * ResubscribeAckTimeout)); err != nil {
		t.Fatal(err)
	}

	if !swapped {
		t.Fatal("the retry reached the old socket")
	}

	if contains(subscribeIDs(old), "sub_4") {
		t.Fatalf("the new socket's queue must not be drained onto the old one, got %v", subscribeIDs(old))
	}

	if !contains(subscribeIDs(fresh), "sub_1") {
		t.Fatalf("the new socket keeps its own window, got %v", subscribeIDs(fresh))
	}
}

func TestResubscribePacingAQueuedOneWhoseArgsNoLongerEncodeDoesNotStallTheRest(t *testing.T) {
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil }, nil)

	args := make([]map[string]any, 0, 5)
	for index := 0; index < 5; index++ {
		each := map[string]any{"channel": fmt.Sprintf("c%d", index)}
		args = append(args, each)
		client.Subscribe("messages:list", each, func(any) {}, nil, "")
	}

	var sent []map[string]any

	client.AttachSocket(recordTo(&sent), nil)
	sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	// The caller mutated a queued subscription's args into something the wire cannot carry.
	args[3]["bad"] = make(chan int)

	handle(t, client, ackFrame("sub_1"))

	if contains(subscribeIDs(sent), "sub_4") {
		t.Fatal("args that no longer encode cannot go out")
	}

	if !contains(subscribeIDs(sent), "sub_5") {
		t.Fatalf("the next queued one still goes out, got %v", subscribeIDs(sent))
	}
}

func TestResubscribePacingTheCallersResendReturnsTheErrorForArgsThatNoLongerEncode(t *testing.T) {
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil }, nil)

	args := make([]map[string]any, 0, 5)
	for index := 0; index < 5; index++ {
		each := map[string]any{"channel": fmt.Sprintf("c%d", index)}
		args = append(args, each)
		client.Subscribe("messages:list", each, func(any) {}, nil, "")
	}

	var sent []map[string]any

	client.AttachSocket(recordTo(&sent), nil)
	sent = nil
	args[4]["bad"] = make(chan int)

	if err := client.ResendSubscriptions(); err == nil {
		t.Fatal("args that no longer encode are the caller's error")
	}

	if got := subscribeIDs(sent); len(got) != 0 {
		t.Fatalf("nothing goes out on a half re-subscribed socket, got %v", got)
	}
}

func TestResubscribePacingShapeSubscriptionsAreNotPaced(t *testing.T) {
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil }, nil)

	for index := 0; index < 5; index++ {
		client.SubscribeShape("roomMessages", map[string]any{"room": fmt.Sprintf("r%d", index)}, func([]any) {}, nil)
	}

	var sent []map[string]any

	client.AttachSocket(recordTo(&sent), nil)
	sent = nil

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatal(err)
	}

	shapes := 0
	for _, frame := range sent {
		if frame["type"] == "shape_subscribe" {
			shapes++
		}
	}

	if shapes != 5 {
		t.Fatalf("every shape subscription goes out at once, got %d", shapes)
	}
}
