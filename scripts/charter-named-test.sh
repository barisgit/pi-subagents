#!/usr/bin/env bash
# charter-named-test.sh — run a single named test (or named-test pattern) and
# fail loudly on a 0-match silent pass.
#
# Usage:
#   bash scripts/charter-named-test.sh <test-file> ['<name-pattern>']
#
# - <test-file>      path to a .test.ts file under test/unit or test/integration
# - <name-pattern>   OPTIONAL substring or regex; passed to --test-name-pattern.
#                    Omit to run the whole file (skill-preferred behavior-level
#                    verifier). Either form fails loudly if 0 tests ran.
#
# Exits non-zero if no test ran (file absent, or pattern matched nothing), even
# if node --test would otherwise report success.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <test-file> [name-pattern]" >&2
  exit 2
fi

file="$1"
pattern="${2:-}"

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
if [[ -n "$pattern" ]]; then
  node "${loader[@]}" --test --test-name-pattern="$pattern" "$file" | tee "$out"
else
  node "${loader[@]}" --test "$file" | tee "$out"
fi
status=${PIPESTATUS[0]}
set -e

# node --test prints `# tests N` in TAP mode and `ℹ tests N` with the
# default Node 24 reporter. If N is 0 the run silently "passed" without
# executing anything matching the pattern — treat that as failure for charter
# evidence purposes.
tests_run=$(awk '/^# tests / { value=$3 } /^ℹ tests / { value=$3 } END { print value }' "$out" || true)
if [[ -z "${tests_run:-}" ]]; then
  echo "charter-named-test: could not determine tests-run count from output" >&2
  exit 1
fi

if [[ "$tests_run" -eq 0 ]]; then
  echo "charter-named-test: 0 tests ran${pattern:+ matching pattern '$pattern'} in $file" >&2
  exit 1
fi

exit "$status"
