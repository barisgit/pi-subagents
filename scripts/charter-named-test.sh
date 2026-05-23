#!/usr/bin/env bash
# charter-named-test.sh — run a single named test (or named-test pattern) and
# fail loudly on a 0-match silent pass.
#
# Usage:
#   bash scripts/charter-named-test.sh <test-file> '<name-pattern>'
#
# - <test-file>      path to a .test.ts file under test/unit or test/integration
# - <name-pattern>   substring or regex; passed to --test-name-pattern
#
# Exits non-zero if no test in the file matches the pattern, even if node --test
# would otherwise report success.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <test-file> <name-pattern>" >&2
  exit 2
fi

file="$1"
pattern="$2"

if [[ ! -f "$file" ]]; then
  echo "charter-named-test: test file not found: $file" >&2
  exit 2
fi

# Decide loader flags from the test directory.
case "$file" in
  test/integration/*)
    loader=(--experimental-transform-types --import ./test/support/register-loader.mjs)
    ;;
  *)
    loader=(--experimental-strip-types)
    ;;
esac

# Capture full TAP output so we can verify a real match occurred.
out=$(mktemp)
trap 'rm -f "$out"' EXIT

set +e
node "${loader[@]}" --test --test-name-pattern="$pattern" "$file" | tee "$out"
status=${PIPESTATUS[0]}
set -e

# node --test prints `# tests N` in the TAP summary. If N is 0 the run
# silently "passed" without executing anything matching the pattern — treat
# that as failure for charter evidence purposes.
tests_run=$(grep -E '^# tests ' "$out" | tail -1 | awk '{print $3}' || true)
if [[ -z "${tests_run:-}" ]]; then
  echo "charter-named-test: could not determine tests-run count from output" >&2
  exit 1
fi

if [[ "$tests_run" -eq 0 ]]; then
  echo "charter-named-test: 0 tests matched pattern '$pattern' in $file" >&2
  exit 1
fi

exit "$status"
