// Calls every function of the `sdk-surface` spec through a generated SDK.
//
// generated_smoke_test.go proves a call reaches the wire. This proves the
// surface handles every SHAPE a model backend renders differently: a no-arg
// function, id / number / array / record / null results, a nullable object, an
// array of objects, a union, an unset optional, bigint arguments and results
// (top level and nested), and keyword-named functions.
//
// Run by `sdks/generated-check.sh go` from a consumer module outside this repo.
package smoke

import (
	"encoding/json"
	"math/big"
	"reflect"
	"testing"

	"lunorasdk/lunora"
	"lunorasdk/lunoraapi"
)

const bigFive = `["$lunora.wire$","bigint","5"]`

func TestSurfaceShapesReachTheWireAndDecode(t *testing.T) {
	var frames []string
	reply := "null"

	client := lunora.NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		var parsed any
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("captured body is not JSON: %v", err)
		}
		// Plain `json.Marshal` (sorted keys), not StableWireKey: the body is
		// ALREADY wire-encoded, and the key function would escape its tagged
		// arrays a second time.
		frame, err := json.Marshal(parsed)
		if err != nil {
			t.Fatalf("re-marshal: %v", err)
		}
		frames = append(frames, string(frame))
		return 200, []byte(`{"result":` + reply + `}`), nil
	})

	expect := func(what string, got any, err error, want any) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %#v, want %#v", what, got, want)
		}
	}

	api := lunoraapi.NewAPI(client)
	items := api.Items

	reply = `2`
	count, err := items.Count(lunoraapi.ItemsCountArgs{}, "")
	expect("count", count, err, lunoraapi.ItemsCountResult(2))
	reply = `{"size":2,"title":"t"}`
	summary, err := items.Summary(lunoraapi.ItemsSummaryArgs{}, "")
	expect("summary", summary, err, lunoraapi.ItemsSummaryResult{Size: 2, Title: "t"})
	reply = `"items_1"`
	created, err := items.Create(lunoraapi.ItemsCreateArgs{Title: "t"}, "")
	expect("create", created, err, lunoraapi.ItemsCreateResult("items_1"))
	reply = `null`
	cleared, err := items.Clear(lunoraapi.ItemsClearArgs{}, "")
	expect("clear", cleared, err, lunoraapi.ItemsClearResult(nil))
	reply = `["a"]`
	tags, err := items.Tags(lunoraapi.ItemsTagsArgs{}, "")
	expect("tags", tags, err, lunoraapi.ItemsTagsResult{"a"})
	reply = `["b"]`
	labels, err := items.Labels(lunoraapi.ItemsLabelsArgs{}, "")
	expect("labels", labels, err, lunoraapi.ItemsLabelsResult{"b"})
	reply = `{"a":1}`
	stats, err := items.Stats(lunoraapi.ItemsStatsArgs{}, "")
	expect("stats", stats, err, lunoraapi.ItemsStatsResult{"a": 1})
	reply = `{"b":2}`
	totals, err := items.Totals(lunoraapi.ItemsTotalsArgs{}, "")
	expect("totals", totals, err, lunoraapi.ItemsTotalsResult{"b": 2})
	reply = `null`
	found, err := items.Find(lunoraapi.ItemsFindArgs{ID: "items_1"}, "")
	expect("find", found, err, nil)
	reply = `[{"kind":"a","title":"t"}]`
	page, err := items.Page(lunoraapi.ItemsPageArgs{}, "")
	expect("page", page, err, lunoraapi.ItemsPageResult{{Kind: lunoraapi.A, Title: "t"}})
	reply = `"x"`
	a := 1.0
	picked, err := items.Pick(lunoraapi.ItemsPickArgs{Choice: lunoraapi.Choice{A: &a, Kind: lunoraapi.X}}, "")
	expect("pick", picked, err, "x")
	reply = `1`
	matched, err := items.Match(lunoraapi.ItemsMatchArgs{Pattern: "p"}, "")
	expect("match", matched, err, lunoraapi.ItemsMatchResult(1))
	typed, err := items.Type(lunoraapi.ItemsTypeArgs{}, "")
	expect("type", typed, err, lunoraapi.ItemsTypeResult(1))
	self, err := items.Self(lunoraapi.ItemsSelfArgs{}, "")
	expect("self", self, err, lunoraapi.ItemsSelfResult(1))

	five := lunora.BigInt{Value: big.NewInt(5)}
	reply = bigFive
	charged, err := api.Ledger.Charge(map[string]any{"amount": five}, "")
	expect("charge", charged, err, five)
	reply = `{"rows":[{"amount":` + bigFive + `}],"total":` + bigFive + `}`
	balances, err := api.Ledger.Balances(map[string]any{"accounts": []any{map[string]any{"id": "acc", "limit": five}}}, "")
	expect("balances", balances, err, map[string]any{"rows": []any{map[string]any{"amount": five}}, "total": five})

	want := []string{
		`{"args":{},"functionPath":"items:count"}`,
		`{"args":{},"functionPath":"items:summary"}`,
		`{"args":{"title":"t"},"functionPath":"items:create"}`,
		`{"args":{},"functionPath":"items:clear"}`,
		`{"args":{},"functionPath":"items:tags"}`,
		`{"args":{},"functionPath":"items:labels"}`,
		`{"args":{},"functionPath":"items:stats"}`,
		`{"args":{},"functionPath":"items:totals"}`,
		`{"args":{"id":"items_1"},"functionPath":"items:find"}`,
		`{"args":{},"functionPath":"items:page"}`,
		`{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}`,
		`{"args":{"pattern":"p"},"functionPath":"items:match"}`,
		`{"args":{},"functionPath":"items:type"}`,
		`{"args":{},"functionPath":"items:self"}`,
		`{"args":{"amount":` + bigFive + `},"functionPath":"ledger:charge"}`,
		`{"args":{"accounts":[{"id":"acc","limit":` + bigFive + `}]},"functionPath":"ledger:balances"}`,
	}

	if !reflect.DeepEqual(frames, want) {
		t.Fatalf("frames:\n got %q\nwant %q", frames, want)
	}
}
