# frozen_string_literal: true

# Runs a generated call, rather than only syntax-checking one.
#
# `ruby -c` was not enough: an earlier revision generated `args.to_dynamic`
# against models rendered with quicktype's `just-types`, which omits that method
# — so every generated call raised NoMethodError while the syntax check stayed
# green. Parsing proves the file is well formed; only invoking proves a request
# reaches the wire.
#
# Run by `sdks/generated-check.sh ruby` against an SDK generated into a scratch
# directory outside this repo. LUNORA_SDK_OUT is the only entry added to the load
# path, so `require "lunora"` can only resolve to the VENDORED transport — not to
# `sdks/ruby/lib`, which a run inside the checkout would find instead.

require "json"

$LOAD_PATH.unshift(ENV.fetch("LUNORA_SDK_OUT"))

require "lunora"
require "api"

captured = nil

client = Lunora::Client.new("https://app.example", http_post: lambda { |_url, _headers, body|
  captured = body

  # The poster hands back a PARSED body: this transport leaves JSON parsing to
  # the caller's HTTP stack rather than assuming one.
  [200, { "result" => { "ok" => true } }]
})

LunoraApi::Api.new(client).messages.list(MessagesListArgs.from_dynamic!({ "channelId" => "chan_1" }))

want = '{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}'
got = Lunora.stable_stringify(JSON.parse(captured))

raise "generated call produced #{got}, want #{want}" unless got == want

puts "OK — the generated surface reaches the wire"
