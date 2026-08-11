# frozen_string_literal: true

# Records which protocol/conformance-cases.json cases this run exercised.
#
# The evidence is produced by the case itself: every test calls
# +ConformanceManifest.covers+ as it runs, and +test_manifest_coverage.rb+
# compares what was recorded against the manifest. A suite cannot satisfy that
# check by listing names it claims to cover — only by executing something under
# each of them.
#
# The recorder lives here rather than in the +test_*.rb+ file that installs the
# check, so that running one test file on its own records without being held to
# the whole manifest, which it cannot cover by construction.

require "json"
require "set"

module ConformanceManifest
  COVERED = Set.new

  class << self
    # Record that the calling test exercises the manifest case +name+.
    def covers(name)
      COVERED << name
    end

    # The case names every SDK suite must exercise.
    def required
      JSON.parse(File.read(File.join(protocol_dir, "conformance-cases.json"))).fetch("required")
    end

    def missing
      required.reject { |name| COVERED.include?(name) }
    end

    private

    def protocol_dir
      directory = File.expand_path(__dir__)
      8.times do
        candidate = File.join(directory, "protocol")
        return candidate if File.file?(File.join(candidate, "conformance-cases.json"))

        parent = File.dirname(directory)
        break if parent == directory

        directory = parent
      end
      raise "could not locate protocol/conformance-cases.json"
    end
  end
end
