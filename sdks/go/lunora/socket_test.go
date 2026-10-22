package lunora

// The WebSocket session: the connect frame every socket opens with, the close codes
// that say why a socket ended, and whisper topics. Each case drives the port's own
// calls and records its manifest name through covers, as the other suites do.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// fakeSocket records every frame the client writes to it, connect included.
type fakeSocket struct {
	frames []map[string]any
}

func (s *fakeSocket) send(frame map[string]any) error {
	s.frames = append(s.frames, frame)

	return nil
}

// recordSubscriptionFrames records what a socket is sent, leaving out connect. The
// tests that count subscription frames use it: AttachSocket sends connect first on
// every open, and connect is not a subscription frame.
func recordSubscriptionFrames(sent *[]map[string]any) FrameSender {
	return func(frame map[string]any) error {
		if frame["type"] != "connect" {
			*sent = append(*sent, frame)
		}

		return nil
	}
}

// TestConnectFrameFirstAndCarriesSessionToken pins the order on every open: connect
// first, then the subscriptions. The session credential rides connect, the RPC bearer
// never does, and neither reaches a URL.
func TestConnectFrameFirstAndCarriesSessionToken(t *testing.T) {
	covers("connect_frame_first_and_carries_session_token")

	goldens, _ := loadFixture(t, "ws-frames.json")["clientFrames"].(map[string]any)
	const session = "session-token"
	const bearer = "rpc-bearer"

	client := NewClient("https://app.example", nil)
	client.SetClientID("client-test")
	client.SetAuthToken(bearer)

	// Registered before any socket is attached, so it goes out on the resend.
	client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, nil, "")

	bare := &fakeSocket{}
	client.AttachSocket(bare.send, nil)

	if len(bare.frames) == 0 || bare.frames[0]["type"] != "connect" {
		t.Fatalf("first frame of an open = %v, want connect", bare.frames)
	}

	if got, want := canonical(t, bare.frames[0]), canonical(t, goldens["connect"]); got != want {
		t.Errorf("connect without a session credential:\n got: %s\nwant: %s", got, want)
	}

	client.SetSessionToken(session)

	open := &fakeSocket{}
	client.AttachSocket(open.send, nil)
	client.ResendSubscriptions()

	if len(open.frames) != 2 || open.frames[0]["type"] != "connect" || open.frames[1]["type"] != "subscribe" {
		t.Fatalf("frames after attach and resend = %v, want [connect, subscribe]", open.frames)
	}

	if got, want := canonical(t, open.frames[0]), canonical(t, goldens["connect-with-token"]); got != want {
		t.Errorf("connect with a session credential:\n got: %s\nwant: %s", got, want)
	}

	for _, frame := range append(bare.frames, open.frames...) {
		if strings.Contains(canonical(t, frame), bearer) {
			t.Errorf("a frame carries the RPC bearer: %s", canonical(t, frame))
		}
	}

	for _, raw := range []string{client.WSURL("", ""), client.WSURL("tenant_a", "ticket-abc")} {
		if strings.Contains(raw, session) || strings.Contains(raw, bearer) {
			t.Errorf("socket URL %q carries a credential", raw)
		}
	}

	// The builder itself, not only what attach emits, matches both token goldens.
	if got, want := canonical(t, BuildConnectFrame("client-test", nil, session)), canonical(t, goldens["connect-with-token"]); got != want {
		t.Errorf("BuildConnectFrame with token:\n got: %s\nwant: %s", got, want)
	}

	if got, want := canonical(t, BuildConnectFrame("client-test", map[string]any{"roomId": "general"}, session)), canonical(t, goldens["connect-with-token-and-context"]); got != want {
		t.Errorf("BuildConnectFrame with token and context:\n got: %s\nwant: %s", got, want)
	}
}

// TestWSURLCarriesOnlyTheAdminTicket pins the one credential allowed in ?token=: the
// admin ticket, and nothing else, even with both other credentials set.
func TestWSURLCarriesOnlyTheAdminTicket(t *testing.T) {
	covers("ws_url_carries_only_the_admin_ticket")

	client := NewClient("https://app.example", nil)
	client.SetAuthToken("rpc-bearer")
	client.SetSessionToken("session-token")

	parsed, err := url.Parse(client.WSURL("tenant_a", "ticket-abc"))
	if err != nil {
		t.Fatalf("parse socket URL: %v", err)
	}

	if got := parsed.Query()["token"]; len(got) != 1 || got[0] != "ticket-abc" {
		t.Errorf("token parameters = %v, want exactly [ticket-abc]", got)
	}

	bare, err := url.Parse(client.WSURL("", ""))
	if err != nil {
		t.Fatalf("parse bare socket URL: %v", err)
	}

	if _, present := bare.Query()["token"]; present {
		t.Errorf("socket URL without a ticket = %q, want no token parameter", bare.String())
	}

	for _, raw := range []string{parsed.String(), bare.String()} {
		if strings.Contains(raw, "session-token") || strings.Contains(raw, "rpc-bearer") {
			t.Errorf("socket URL %q carries a credential that is not the ticket", raw)
		}
	}
}

// TestAttachSocketCarriesConnectionContext pins that context reaches connect only when
// the caller gives it, and that each combination matches its golden.
func TestAttachSocketCarriesConnectionContext(t *testing.T) {
	covers("attach_socket_carries_connection_context")

	goldens, _ := loadFixture(t, "ws-frames.json")["clientFrames"].(map[string]any)
	context := map[string]any{"roomId": "general"}

	client := NewClient("https://app.example", nil)
	client.SetClientID("client-test")

	steps := []struct {
		name    string
		token   string
		context map[string]any
		golden  string
	}{
		{name: "neither", golden: "connect"},
		{name: "context only", context: context, golden: "connect-with-context"},
		{name: "token and context", token: "session-token", context: context, golden: "connect-with-token-and-context"},
		{name: "token only", token: "session-token", golden: "connect-with-token"},
	}

	for _, step := range steps {
		t.Run(step.name, func(t *testing.T) {
			client.SetSessionToken(step.token)

			socket := &fakeSocket{}
			client.AttachSocket(socket.send, step.context)

			if len(socket.frames) != 1 {
				t.Fatalf("attach sent %d frames, want only connect", len(socket.frames))
			}

			if got, want := canonical(t, socket.frames[0]), canonical(t, goldens[step.golden]); got != want {
				t.Errorf("connect:\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// TestCloseCodesDriveTokenExpiry runs every closeSequences case through the port's own
// calls. The notification count is the contract; subscriptionErrors is checked where
// the case gives one.
func TestCloseCodesDriveTokenExpiry(t *testing.T) {
	covers("close_codes_drive_token_expiry")

	sequences, _ := loadFixture(t, "ws-frames.json")["closeSequences"].(map[string]any)
	cases, _ := sequences["cases"].([]any)

	if len(cases) == 0 {
		t.Fatal("ws-frames.json has no closeSequences cases")
	}

	for _, entry := range cases {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			client := NewClient("https://app.example", nil)
			client.SetSessionToken("session-1")

			subscriptionErrors := 0
			client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, func(SubscriptionError) { subscriptionErrors++ }, "")

			// A listener that panics runs first: it must not stop the counting listener
			// behind it, nor the close or frame that notified them from being handled.
			client.OnTokenExpired(func() { panic("listener failure") })

			notifications := 0
			client.OnTokenExpired(func() { notifications++ })

			// An unregistered listener must never run.
			unregistered := 0
			unregister := client.OnTokenExpired(func() { unregistered++ })
			unregister()

			socket := &fakeSocket{}
			credentials := 1

			steps, _ := testCase["steps"].([]any)
			for _, raw := range steps {
				step, _ := raw.(map[string]any)

				if _, ok := step["attach"]; ok {
					client.AttachSocket(socket.send, nil)

					continue
				}

				if closeStep, ok := step["close"].(map[string]any); ok {
					code, _ := closeStep["code"].(float64)
					reason, _ := closeStep["reason"].(string)
					client.DetachSocket(int(code), reason)

					if client.Online() {
						t.Fatalf("client still online after close %d", int(code))
					}

					continue
				}

				if frame, ok := step["frame"]; ok {
					encoded, err := json.Marshal(frame)
					if err != nil {
						t.Fatalf("marshal frame: %v", err)
					}

					if _, err := client.HandleFrame(encoded); err != nil {
						t.Fatalf("handle frame: %v", err)
					}

					continue
				}

				if _, ok := step["credentialChange"]; ok {
					credentials++
					client.SetSessionToken(fmt.Sprintf("session-%d", credentials))

					continue
				}

				t.Fatalf("unknown step %v", step)
			}

			if want, _ := testCase["tokenExpiredNotifications"].(float64); notifications != int(want) {
				t.Errorf("token-expired notifications = %d, want %d", notifications, int(want))
			}

			if unregistered != 0 {
				t.Errorf("unregistered listener ran %d times", unregistered)
			}

			if want, present := testCase["subscriptionErrors"].(float64); present && subscriptionErrors != int(want) {
				t.Errorf("subscription errors = %d, want %d", subscriptionErrors, int(want))
			}
		})
	}
}

// TestWhisperFramesJoinSendAndDeliver checks the three client frames against their
// goldens, then runs every whisper server frame and compares what the topic listeners
// receive with the fixture's delivered list.
func TestWhisperFramesJoinSendAndDeliver(t *testing.T) {
	covers("whisper_frames_join_send_and_deliver")

	fixture := loadFixture(t, "ws-frames.json")
	goldens, _ := fixture["clientFrames"].(map[string]any)
	whisper, _ := fixture["whisperFrames"].(map[string]any)

	if got, want := canonical(t, BuildWhisperSubscribeFrame("room:general")), canonical(t, goldens["whisper-subscribe"]); got != want {
		t.Errorf("whisper_subscribe:\n got: %s\nwant: %s", got, want)
	}

	if got, want := canonical(t, BuildWhisperUnsubscribeFrame("room:general")), canonical(t, goldens["whisper-unsubscribe"]); got != want {
		t.Errorf("whisper_unsubscribe:\n got: %s\nwant: %s", got, want)
	}

	built, err := BuildWhisperFrame("room:general", map[string]any{"text": "hi"})
	if err != nil {
		t.Fatalf("build whisper: %v", err)
	}

	if got, want := canonical(t, built), canonical(t, goldens["whisper-send"]); got != want {
		t.Errorf("whisper:\n got: %s\nwant: %s", got, want)
	}

	client := NewClient("https://app.example", nil)
	if client.Whisper("room:general", map[string]any{"text": "hi"}) {
		t.Fatal("Whisper reported sent with no socket attached")
	}

	socket := &fakeSocket{}
	client.AttachSocket(socket.send, nil)

	if !client.Whisper("room:general", map[string]any{"text": "hi"}) {
		t.Fatal("Whisper reported not sent on an attached socket")
	}

	if got, want := canonical(t, socket.frames[len(socket.frames)-1]), canonical(t, goldens["whisper-send"]); got != want {
		t.Errorf("sent whisper:\n got: %s\nwant: %s", got, want)
	}

	// Joining and leaving an attached socket: the frame goes out at the first listener
	// and at the last, never in between, and a repeated unsubscribe sends nothing.
	joins := NewClient("https://app.example", nil)
	joined := &fakeSocket{}
	joins.AttachSocket(joined.send, nil)

	leaveFirst := joins.WhisperSubscribe("room:general", func(any) {})
	leaveSecond := joins.WhisperSubscribe("room:general", func(any) {})

	if len(joined.frames) != 2 || joined.frames[1]["type"] != "whisper_subscribe" {
		t.Fatalf("frames after two listeners = %v, want connect then one whisper_subscribe", joined.frames)
	}

	leaveFirst()

	if len(joined.frames) != 2 {
		t.Fatalf("leaving with a listener still on the topic sent %d frames, want none", len(joined.frames)-2)
	}

	leaveSecond()

	if len(joined.frames) != 3 {
		t.Fatalf("leaving the last listener sent %d frames, want one whisper_unsubscribe", len(joined.frames)-2)
	}

	if got, want := canonical(t, joined.frames[2]), canonical(t, goldens["whisper-unsubscribe"]); got != want {
		t.Errorf("last leave:\n got: %s\nwant: %s", got, want)
	}

	leaveSecond()

	if len(joined.frames) != 3 {
		t.Fatalf("a repeated unsubscribe sent a frame, want none")
	}

	// The topic was forgotten, so the next open rejoins nothing.
	reopened := &fakeSocket{}
	joins.DetachSocket(0, "")
	joins.AttachSocket(reopened.send, nil)

	if len(reopened.frames) != 1 || reopened.frames[0]["type"] != "connect" {
		t.Errorf("reopened socket sent %v, want connect alone", reopened.frames)
	}

	cases, _ := whisper["serverFrames"].([]any)

	for _, entry := range cases {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			client := NewClient("https://app.example", nil)

			// Joined to room:general only: a frame for room:other must reach nobody here.
			delivered := []any{}

			client.WhisperSubscribe("room:general", func(value any) {
				encoded, err := EncodeWire(value)
				if err != nil {
					t.Fatalf("encode delivered value: %v", err)
				}

				delivered = append(delivered, map[string]any{"topic": "room:general", "value": encoded})
			})

			raw, err := json.Marshal(testCase["frame"])
			if err != nil {
				t.Fatalf("marshal frame: %v", err)
			}

			if _, err := client.HandleFrame(raw); err != nil {
				t.Fatalf("handle frame: %v", err)
			}

			want := testCase["delivered"]
			if got := canonical(t, delivered); got != canonical(t, want) {
				t.Errorf("delivered:\n got: %s\nwant: %s", got, canonical(t, want))
			}
		})
	}
}

// TestWhisperTopicsRejoinAfterReconnect pins that every joined topic is joined again
// right after connect, on each open, and that a joined room is sent to without waiting
// for an ack.
func TestWhisperTopicsRejoinAfterReconnect(t *testing.T) {
	covers("whisper_topics_rejoin_after_reconnect")

	fixture := loadFixture(t, "ws-frames.json")
	goldens, _ := fixture["clientFrames"].(map[string]any)
	whisper, _ := fixture["whisperFrames"].(map[string]any)

	client := NewClient("https://app.example", nil)
	client.SetClientID("client-test")

	room := client.ConnectRoom("general", func(any) {})
	defer room.Close()

	if rejoin, _ := whisper["rejoinOnReconnect"].([]any); canonical(t, rejoin) != canonical(t, []string{"room:general"}) {
		t.Fatalf("rejoinOnReconnect = %s, want [room:general]", canonical(t, rejoin))
	}

	for open := 1; open <= 2; open++ {
		socket := &fakeSocket{}
		client.AttachSocket(socket.send, nil)

		if len(socket.frames) != 2 {
			t.Fatalf("open %d sent %d frames, want connect then whisper_subscribe", open, len(socket.frames))
		}

		if got, want := canonical(t, socket.frames[0]), canonical(t, goldens["connect"]); got != want {
			t.Errorf("open %d: first frame:\n got: %s\nwant: %s", open, got, want)
		}

		if got, want := canonical(t, socket.frames[1]), canonical(t, goldens["whisper-subscribe"]); got != want {
			t.Errorf("open %d: rejoin:\n got: %s\nwant: %s", open, got, want)
		}

		if !room.Send("hello") {
			t.Errorf("open %d: Send reported not sent on an attached socket", open)
		}

		client.DetachSocket(0, "")
	}
}
