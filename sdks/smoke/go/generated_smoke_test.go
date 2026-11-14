// Runs a generated call, rather than only compiling one.
//
// `go build` proves the shapes line up. It does not prove a call reaches the
// wire: Java shipped a surface that compiled and threw on the first invocation,
// and Ruby one whose every method raised NoMethodError, both with the
// compile-or-parse gate green.
//
// `sdks/generated-check.sh go` copies this into a throwaway consumer module whose
// go.mod carries the two lines a real consumer writes:
//
//	require lunorasdk v0.0.0
//	replace lunorasdk => ../sdk
//
// That is why the imports below name `lunorasdk` and not this repo's module: the
// point of the check is that the generated SDK resolves from OUTSIDE the
// monorepo, where `github.com/anolilab/lunora-go` does not exist.

package smoke

import (
	"encoding/json"
	"testing"

	"lunorasdk/lunora"
	"lunorasdk/lunoraapi"
)

func TestGeneratedCallReachesTheWire(t *testing.T) {
	var captured []byte

	client := lunora.NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		captured = body

		return 200, []byte(`{"result":{"ok":true}}`), nil
	})

	if _, err := lunoraapi.NewAPI(client).Messages.List(lunoraapi.MessagesListArgs{ChannelID: "chan_1"}, ""); err != nil {
		t.Fatalf("generated call: %v", err)
	}

	var parsed any

	if err := json.Unmarshal(captured, &parsed); err != nil {
		t.Fatalf("captured body is not JSON: %v", err)
	}

	got, err := lunora.StableWireKey(parsed)
	if err != nil {
		t.Fatalf("stable key: %v", err)
	}

	const want = `{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}`

	if got != want {
		t.Errorf("generated call produced %s, want %s", got, want)
	}
}

// The generated watch member reaches the primitive with the right function path. The
// subscribe frame is sent at call time, the first data frame is decoded through the
// channel, and calling Unsubscribe sends the unsubscribe for the same id.
func TestGeneratedWatchReachesThePrimitive(t *testing.T) {
	var frames []map[string]any

	client := lunora.NewClient("https://app.example", func(_ string, _ map[string]string, _ []byte) (int, []byte, error) {
		return 200, []byte(`{"result":{"ok":true}}`), nil
	})

	client.AttachSocket(func(frame map[string]any) error {
		frames = append(frames, frame)

		return nil
	}, nil)

	events, unsubscribe := lunoraapi.NewAPI(client).Messages.WatchList(lunoraapi.MessagesListArgs{ChannelID: "chan_1"}, "")

	subscribe := frameOfType(t, frames, "subscribe")
	query, _ := subscribe["query"].(map[string]any)

	if path, _ := query["functionPath"].(string); path != "messages:list" {
		t.Fatalf("watch subscribed to %q, want messages:list", path)
	}

	args, err := lunora.StableWireKey(query["args"])
	if err != nil {
		t.Fatalf("stable key: %v", err)
	}

	if want := `{"channelId":"chan_1"}`; args != want {
		t.Fatalf("watch sent args %s, want %s", args, want)
	}

	id, _ := subscribe["id"].(string)

	raw, err := json.Marshal(map[string]any{"cursor": 1, "data": map[string]any{"ok": true}, "id": id, "type": "data"})
	if err != nil {
		t.Fatalf("marshal data frame: %v", err)
	}

	if _, err := client.HandleFrame(raw); err != nil {
		t.Fatalf("handle data frame: %v", err)
	}

	event := <-events

	if event.Err != nil {
		t.Fatalf("watch delivered an error: %v", event.Err)
	}

	if value, _ := event.Value.(map[string]any); value["ok"] != true {
		t.Fatalf("watch yielded %v, want {ok: true}", event.Value)
	}

	unsubscribe()

	unsubscribed := frameOfType(t, frames, "unsubscribe")

	if got, _ := unsubscribed["id"].(string); got != id {
		t.Fatalf("closing the watch unsubscribed %q, want %q", got, id)
	}
}

// frameOfType returns the single frame of the given type, failing when none or several were sent.
func frameOfType(t *testing.T, frames []map[string]any, kind string) map[string]any {
	t.Helper()

	var found []map[string]any

	for _, frame := range frames {
		if frame["type"] == kind {
			found = append(found, frame)
		}
	}

	if len(found) != 1 {
		t.Fatalf("sent %d %s frames, want exactly one", len(found), kind)
	}

	return found[0]
}
