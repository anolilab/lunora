# frozen_string_literal: true

# Calls every function of the `sdk-surface` spec through a generated SDK.
#
# `generated_smoke.rb` proves a call reaches the wire. This proves the surface
# handles every SHAPE a model backend renders differently: a no-arg function,
# id / number / array / record / null results, a nullable object, an array of
# objects, a union, an unset optional, bigint arguments and results (top level
# and nested), and keyword-named functions. quicktype gives `from_dynamic!` and
# `to_dynamic` to struct classes only, so every non-struct shape here once
# raised NoMethodError — including `{}` arguments.
#
# Run by `sdks/generated-check.sh ruby`; see `generated_smoke.rb` for why
# LUNORA_SDK_OUT is the only load-path entry.

require "json"

$LOAD_PATH.unshift(ENV.fetch("LUNORA_SDK_OUT"))

require "lunora"
require "api"

BIG_FIVE = '["$lunora.wire$","bigint","5"]'

frames = []
reply = +"null"

client = Lunora::Client.new("https://app.example", http_post: lambda { |_url, _headers, body|
  frames << Lunora.stable_stringify(JSON.parse(body))

  [200, JSON.parse("{\"result\":#{reply}}")]
})

expect = lambda { |what, got, want|
  raise "#{what}: got #{got.inspect}, want #{want.inspect}" unless got == want
}

api = LunoraApi::Api.new(client)
items = api.items
five = Lunora::WireBigInt.new(5)

reply.replace("2")
expect.call("count", items.count({}), 2)
reply.replace('{"size":2,"title":"t"}')
summary = items.summary({})
expect.call("summary", [summary.size, summary.title], [2, "t"])
reply.replace('"items_1"')
expect.call("create", items.create(ItemsCreateArgs.from_dynamic!({ "title" => "t" })), "items_1")
reply.replace("null")
expect.call("clear", items.clear({}), nil)
reply.replace('["a"]')
expect.call("tags", items.tags({}), ["a"])
reply.replace('["b"]')
expect.call("labels", items.labels({}), ["b"])
reply.replace('{"a":1}')
expect.call("stats", items.stats({}), { "a" => 1 })
reply.replace('{"b":2}')
expect.call("totals", items.totals({}), { "b" => 2 })
reply.replace("null")
expect.call("find", items.find(ItemsFindArgs.from_dynamic!({ "id" => "items_1" })), nil)
reply.replace('[{"kind":"a","title":"t"}]')
expect.call("page", items.page({}), [{ "kind" => "a", "title" => "t" }])
reply.replace('"x"')
expect.call("pick", items.pick(ItemsPickArgs.from_dynamic!({ "choice" => { "a" => 1, "kind" => "x" } })), "x")
reply.replace("1")
expect.call("match", items.match(ItemsMatchArgs.from_dynamic!({ "pattern" => "p" })), 1)
expect.call("type", items.type({}), 1)
expect.call("self", items.self_({}), 1)

reply.replace(BIG_FIVE)
expect.call("charge", api.ledger.charge({ "amount" => five }), five)
reply.replace("{\"rows\":[{\"amount\":#{BIG_FIVE}}],\"total\":#{BIG_FIVE}}")
balances = api.ledger.balances({ "accounts" => [{ "id" => "acc", "limit" => five }] })
expect.call("balances", balances, { "rows" => [{ "amount" => five }], "total" => five })

want = [
  '{"args":{},"functionPath":"items:count"}',
  '{"args":{},"functionPath":"items:summary"}',
  '{"args":{"title":"t"},"functionPath":"items:create"}',
  '{"args":{},"functionPath":"items:clear"}',
  '{"args":{},"functionPath":"items:tags"}',
  '{"args":{},"functionPath":"items:labels"}',
  '{"args":{},"functionPath":"items:stats"}',
  '{"args":{},"functionPath":"items:totals"}',
  '{"args":{"id":"items_1"},"functionPath":"items:find"}',
  '{"args":{},"functionPath":"items:page"}',
  '{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}',
  '{"args":{"pattern":"p"},"functionPath":"items:match"}',
  '{"args":{},"functionPath":"items:type"}',
  '{"args":{},"functionPath":"items:self"}',
  "{\"args\":{\"amount\":#{BIG_FIVE}},\"functionPath\":\"ledger:charge\"}",
  "{\"args\":{\"accounts\":[{\"id\":\"acc\",\"limit\":#{BIG_FIVE}}]},\"functionPath\":\"ledger:balances\"}"
]

expect.call("frame count", frames.length, want.length)
frames.zip(want).each_with_index { |(got, wanted), index| expect.call("frame #{index}", got, wanted) }

puts "OK — every sdk-surface shape reaches the wire and decodes"
