# frozen_string_literal: true

# Lunora Ruby SDK — a minimal, protocol-conformant client for a Lunora
# deployment.
#
# See protocol/README.md for the language-independent wire protocol this
# implements. Deliberately dependency-free: the HTTP poster and the socket
# frame sender are injected, so the conformance suite runs offline and a
# consumer keeps its own transport rather than inheriting ours.

require_relative "lunora/client"
require_relative "lunora/key"
require_relative "lunora/offline"
require_relative "lunora/optimistic"
require_relative "lunora/wire"

module Lunora
  VERSION = "0.1.0"
end
