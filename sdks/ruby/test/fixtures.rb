# frozen_string_literal: true

# Locates and loads the shared protocol fixtures (protocol/fixtures/*.json).
#
# Extracted from test_conformance.rb so a suite that only needs the loader — the
# optimistic and offline-queue cases — does not drag the whole wire-conformance
# run in behind a require.

require "json"

require_relative "../lib/lunora"

module FixtureLoader
  def fixtures_dir
    @fixtures_dir ||= begin
      directory = File.expand_path(__dir__)
      found = nil
      8.times do
        candidate = File.join(directory, "protocol", "fixtures")
        if File.directory?(candidate)
          found = candidate
          break
        end
        parent = File.dirname(directory)
        break if parent == directory

        directory = parent
      end
      found || raise("could not locate protocol/fixtures")
    end
  end

  def fixture(name)
    JSON.parse(File.read(File.join(fixtures_dir, name)))
  end

  # Re-serialise so two structures compare as text with a canonical key order,
  # independent of the order the fixture file happens to use.
  def canonical(value)
    Lunora.stable_stringify(value)
  end
end
