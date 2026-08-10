# frozen_string_literal: true

# Runs a generated call, rather than only syntax-checking one.
#
# `ruby -c` was not enough: an earlier revision generated `args.to_dynamic`
# against models rendered with quicktype's `just-types`, which omits that method
# — so every generated call raised NoMethodError while the syntax check stayed
# green. Parsing proves the file is well formed; only invoking proves a request
# reaches the wire.

require "json"
require_relative "lib/lunora/client"
require_relative "lib/lunora/key"
require_relative "generated_check/api"

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
