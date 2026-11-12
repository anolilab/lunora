package lunora

// The live-query retry hint: a query error's retryAfterMs schedules exactly one cold
// re-subscribe, which the caller fires through RetryDueSubscriptions. Checked against
// the subscriptionRetry golden in protocol/fixtures/ws-frames.json. Written without the
// Go toolchain available, so this file has not been compiled or run.

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// subscriptionRetryFixture returns the subscriptionRetry golden.
func subscriptionRetryFixture(t *testing.T) map[string]any {
	t.Helper()

	golden, _ := loadFixture(t, "ws-frames.json")["subscriptionRetry"].(map[string]any)
	if golden == nil {
		t.Fatal("ws-frames.json has no subscriptionRetry group")
	}

	return golden
}

// feedFrame delivers one server frame through the wire path the socket read loop uses.
func feedFrame(t *testing.T, client *Client, frame any) {
	t.Helper()

	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := client.HandleFrame(raw); err != nil {
		t.Fatal(err)
	}
}

// normalise round-trips a value through JSON so numbers and nested maps compare alike.
func normalise(t *testing.T, value any) any {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}

	return out
}

// openSubscribed returns a client with sub_1 subscribed on an attached socket, holding
// the golden seed frame and nothing else. sent receives the frames written after the
// seed; errs, when non-nil, receives every error the subscription's callback sees.
func openSubscribed(t *testing.T, retry map[string]any, sent *[]map[string]any, errs *[]SubscriptionError) *Client {
	t.Helper()

	client := NewClient("https://app.example", nil)
	client.AttachSocket(recordSubscriptionFrames(sent), nil)

	var onError ErrorHandler

	if errs != nil {
		onError = func(err SubscriptionError) { *errs = append(*errs, err) }
	}

	client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, onError, "")
	feedFrame(t, client, retry["seedFrame"])
	*sent = nil

	return client
}

// hinted returns openSubscribed with the golden hint delivered, so a retry is pending.
func hinted(t *testing.T, retry map[string]any, sent *[]map[string]any) *Client {
	t.Helper()

	client := openSubscribed(t, retry, sent, nil)
	feedFrame(t, client, retry["hintFrame"])

	if _, ok := client.NextSubscriptionRetryAt(); !ok {
		t.Fatal("the golden hint must schedule a retry")
	}

	return client
}

func TestSubscriptionRetryColdResubscribeAtTheHint(t *testing.T) {
	retry := subscriptionRetryFixture(t)
	delay := time.Duration(retry["retryAfterMs"].(float64)) * time.Millisecond

	var sent []map[string]any

	client := openSubscribed(t, retry, &sent, nil)

	t0 := time.Now()

	feedFrame(t, client, retry["hintFrame"])

	t1 := time.Now()

	due, ok := client.NextSubscriptionRetryAt()
	if !ok {
		t.Fatal("the hint must schedule a retry")
	}

	if due.Before(t0.Add(delay)) || due.After(t1.Add(delay)) {
		t.Fatalf("retry due at %v, want between %v and %v", due, t0.Add(delay), t1.Add(delay))
	}

	if n, err := client.RetryDueSubscriptions(due.Add(-time.Millisecond)); err != nil || n != 0 || len(sent) != 0 {
		t.Fatalf("before the deadline: n=%d err=%v sent=%d, want nothing sent", n, err, len(sent))
	}

	if n, err := client.RetryDueSubscriptions(due); err != nil || n != 1 {
		t.Fatalf("at the deadline: n=%d err=%v, want exactly one frame", n, err)
	}

	if len(sent) != 1 {
		t.Fatalf("sent %d frames, want 1", len(sent))
	}

	if !reflect.DeepEqual(normalise(t, sent[0]), normalise(t, retry["retryFrame"])) {
		t.Fatalf("retry frame = %v, want the cold subscribe golden %v", sent[0], retry["retryFrame"])
	}

	if n, _ := client.RetryDueSubscriptions(due.Add(60 * time.Second)); n != 0 {
		t.Fatalf("a fired retry fired again: n=%d", n)
	}

	if _, ok := client.NextSubscriptionRetryAt(); ok {
		t.Fatal("no retry may remain pending once it has fired")
	}
}

func TestSubscriptionRetryNothingDroppedWithoutASocket(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	client := NewClient("https://app.example", nil)
	client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, nil, "")
	feedFrame(t, client, retry["seedFrame"])
	feedFrame(t, client, retry["hintFrame"])

	due, ok := client.NextSubscriptionRetryAt()
	if !ok {
		t.Fatal("the hint must schedule a retry even with no socket")
	}

	if n, err := client.RetryDueSubscriptions(due.Add(time.Second)); err != nil || n != 0 {
		t.Fatalf("no socket: n=%d err=%v, want 0 and nil", n, err)
	}

	if _, ok := client.NextSubscriptionRetryAt(); !ok {
		t.Fatal("a retry due with no socket attached must not be dropped")
	}
}

func TestSubscriptionRetryHintLeavesErrorCallbackAsBefore(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	var (
		sent []map[string]any
		errs []SubscriptionError
	)

	client := openSubscribed(t, retry, &sent, &errs)
	feedFrame(t, client, retry["hintFrame"])

	if len(errs) != 1 {
		t.Fatalf("error callback fired %d times, want 1", len(errs))
	}

	if errs[0].Code != "SUBSCRIPTION_REFRESH_FAILED" {
		t.Fatalf("error code = %q, want SUBSCRIPTION_REFRESH_FAILED", errs[0].Code)
	}
}

func TestSubscriptionRetryLaterHintReplaces(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	var sent []map[string]any

	client := hinted(t, retry, &sent)

	first, _ := client.NextSubscriptionRetryAt()

	feedFrame(t, client, retry["laterHintFrame"])

	second, ok := client.NextSubscriptionRetryAt()
	if !ok {
		t.Fatal("the later hint must leave a retry pending")
	}

	if !second.After(first) {
		t.Fatalf("later hint due %v, want after the first %v", second, first)
	}

	if n, _ := client.RetryDueSubscriptions(first); n != 0 || len(sent) != 0 {
		t.Fatalf("the replaced retry fired at its old deadline: n=%d sent=%d", n, len(sent))
	}

	if n, _ := client.RetryDueSubscriptions(second); n != 1 {
		t.Fatalf("the replacing retry must fire at its new deadline: n=%d", n)
	}
}

func TestSubscriptionRetryAnsweringFramesCancel(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	for _, entry := range retry["cancelFrames"].([]any) {
		cancel := entry.(map[string]any)
		name, _ := cancel["name"].(string)

		t.Run(name, func(t *testing.T) {
			var sent []map[string]any

			client := hinted(t, retry, &sent)

			feedFrame(t, client, cancel["frame"])

			if _, ok := client.NextSubscriptionRetryAt(); ok {
				t.Fatalf("a %s frame must cancel the pending retry", name)
			}

			if n, _ := client.RetryDueSubscriptions(time.Now().Add(60 * time.Second)); n != 0 || len(sent) != 0 {
				t.Fatalf("a cancelled retry sent: n=%d sent=%d", n, len(sent))
			}
		})
	}
}

func TestSubscriptionRetryFramesWithoutAValidHintScheduleNothing(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	for _, entry := range retry["noRetryFrames"].([]any) {
		rejected := entry.(map[string]any)
		name, _ := rejected["name"].(string)

		t.Run(name, func(t *testing.T) {
			var sent []map[string]any

			client := openSubscribed(t, retry, &sent, nil)

			feedFrame(t, client, rejected["frame"])

			if _, ok := client.NextSubscriptionRetryAt(); ok {
				t.Fatalf("a %s error must schedule no retry", name)
			}
		})
	}
}

func TestSubscriptionRetryUnsubscribeAndSocketChangesCancel(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	assertCancelled := func(t *testing.T, client *Client) {
		t.Helper()

		if _, ok := client.NextSubscriptionRetryAt(); ok {
			t.Fatal("the pending retry must be cancelled")
		}
	}

	t.Run("unsubscribe", func(t *testing.T) {
		var sent []map[string]any

		client := NewClient("https://app.example", nil)
		client.AttachSocket(recordSubscriptionFrames(&sent), nil)

		unsubscribe := client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, nil, "")
		feedFrame(t, client, retry["seedFrame"])
		feedFrame(t, client, retry["hintFrame"])
		unsubscribe()

		assertCancelled(t, client)
	})

	t.Run("detach", func(t *testing.T) {
		var sent []map[string]any

		client := hinted(t, retry, &sent)
		client.DetachSocket(0, "")

		assertCancelled(t, client)
	})

	t.Run("attach", func(t *testing.T) {
		var sent []map[string]any

		client := hinted(t, retry, &sent)
		client.AttachSocket(recordSubscriptionFrames(&sent), nil)

		assertCancelled(t, client)
	})

	t.Run("close", func(t *testing.T) {
		var sent []map[string]any

		client := hinted(t, retry, &sent)
		client.Close()

		assertCancelled(t, client)
	})
}

func TestSubscriptionRetryShapeErrorSchedulesNothing(t *testing.T) {
	var sent []map[string]any

	client := NewClient("https://app.example", nil)
	client.AttachSocket(recordSubscriptionFrames(&sent), nil)
	client.SubscribeShape("messages:list", map[string]any{"channel": "general"}, func([]any) {}, func(SubscriptionError) {})

	hint := map[string]any{"code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 5000}
	feedFrame(t, client, map[string]any{"id": "shape_1", "type": "error", "error": hint})

	if _, ok := client.NextSubscriptionRetryAt(); ok {
		t.Fatal("a shape error must not schedule a query re-subscribe")
	}
}

func TestSubscriptionRetryHintIsClampedToMaxRetryAfter(t *testing.T) {
	retry := subscriptionRetryFixture(t)

	var sent []map[string]any

	client := openSubscribed(t, retry, &sent, nil)

	t0 := time.Now()

	hint := map[string]any{"code": "SUBSCRIPTION_REFRESH_FAILED", "message": "refresh failed", "retryAfterMs": 3600000}
	feedFrame(t, client, map[string]any{"id": "sub_1", "type": "error", "error": hint})

	t1 := time.Now()

	due, ok := client.NextSubscriptionRetryAt()
	if !ok {
		t.Fatal("a clamped hint must still schedule a retry")
	}

	capDelay := time.Duration(MaxRetryAfterMs) * time.Millisecond
	if due.Before(t0.Add(capDelay)) || due.After(t1.Add(capDelay)) {
		t.Fatalf("retry due at %v, want the %v cap between %v and %v", due, capDelay, t0.Add(capDelay), t1.Add(capDelay))
	}
}
