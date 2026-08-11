# frozen_string_literal: true

# Fails the run if it did not exercise every case in the shared manifest.
#
# +Minitest.after_run+ is the runner's own after-all hook, and the only place
# that can see what the whole run did — a test cannot observe its siblings.
# +abort+ rather than +raise+ so the message reads as a gate rather than as a
# crash; both exit non-zero.
#
# The file is named +test_*.rb+ so the full-suite glob loads it, and the check
# only exists once it is loaded: +ruby -Ilib test/test_key.rb+ on its own records
# coverage without being held to a manifest one file cannot cover.

require "minitest/autorun"

require_relative "manifest"

Minitest.after_run do
  missing = ConformanceManifest.missing

  unless missing.empty?
    abort "protocol/conformance-cases.json requires cases this suite did not run: #{missing.sort.join(", ")} " \
          "(add a test that calls ConformanceManifest.covers with that name)"
  end
end
