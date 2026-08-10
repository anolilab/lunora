// Runs a generated call, rather than only compiling one.
//
// `go build` proves the shapes line up. It does not prove a call reaches the
// wire: Java shipped a surface that compiled and threw on the first invocation,
// and Ruby one whose every method raised NoMethodError, both with the
// compile-or-parse gate green.
//
// Behind a build tag because it imports a package that `lunora sdk generate`
// produces rather than one that is committed — the main conformance suite runs
// before generation and must not fail to build on its absence. Run it with
// `go test -tags generatedcheck ./smoke/...` after generating.
//go:build generatedcheck

package smoke

import (
	"encoding/json"
	"testing"

	lunoraapi "github.com/anolilab/lunora-go/generatedcheck"
	"github.com/anolilab/lunora-go/lunora"
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
