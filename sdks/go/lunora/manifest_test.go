package lunora

// Fails the package if this run did not exercise every case named in
// protocol/conformance-cases.json.
//
// TestMain is the only aggregate hook `go test` offers: a test cannot see what
// its siblings did, and there is no after-all callback. So each case records its
// manifest name as it runs — evidence produced by executing the case, not a
// hand-kept list of names a suite claims to cover — and the comparison happens
// once the whole package has run.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

var (
	coveredMutex sync.Mutex
	coveredNames = map[string]bool{}
)

// covers records that the calling test exercises the manifest case name.
func covers(name string) {
	coveredMutex.Lock()
	defer coveredMutex.Unlock()

	coveredNames[name] = true
}

// findUp walks up from the working directory looking for a repo-relative path.
func findUp(relative string) (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}

	for range 8 {
		candidate := filepath.Join(directory, relative)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}

		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}

		directory = parent
	}

	return "", fmt.Errorf("could not locate %s", relative)
}

func requiredCases() ([]string, error) {
	path, err := findUp(filepath.Join("protocol", "conformance-cases.json"))
	if err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var manifest struct {
		Required []string `json:"required"`
	}

	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	if len(manifest.Required) == 0 {
		return nil, errors.New("the manifest must list at least one required case")
	}

	return manifest.Required, nil
}

func uncoveredCases() ([]string, error) {
	required, err := requiredCases()
	if err != nil {
		return nil, err
	}

	coveredMutex.Lock()
	defer coveredMutex.Unlock()

	var missing []string

	for _, name := range required {
		if !coveredNames[name] {
			missing = append(missing, name)
		}
	}

	sort.Strings(missing)

	return missing, nil
}

func TestMain(m *testing.M) {
	code := m.Run()

	// A filtered run cannot cover the manifest by construction, so enforcing it
	// there would only teach people to ignore the failure.
	filter := flag.Lookup("test.run")
	filtered := filter != nil && filter.Value.String() != ""

	if !filtered {
		missing, err := uncoveredCases()

		switch {
		case err != nil:
			fmt.Fprintf(os.Stderr, "conformance manifest unreadable: %v\n", err)

			code = 1
		case len(missing) > 0:
			fmt.Fprintf(
				os.Stderr,
				"protocol/conformance-cases.json requires cases this suite did not run: %s\n"+
					"(add a test that calls covers() with that name)\n",
				strings.Join(missing, ", "),
			)

			code = 1
		}
	}

	os.Exit(code)
}
