#!/usr/bin/env bash
# charter-tsc-no-new-errors.sh — run `npx tsc --noEmit` and assert no new
# errors beyond the project's `.tsc-errors-baseline.txt` snapshot.
#
# Exit 0 only when the set of current TS error file:line keys is a subset
# of the baseline (i.e. no new errors). Reports diff on failure.

set -euo pipefail

baseline=".tsc-errors-baseline.txt"
if [[ ! -f "$baseline" ]]; then
  echo "charter-tsc: baseline file missing: $baseline" >&2
  exit 2
fi

current=$(mktemp); trap 'rm -f "$current"' EXIT

# tsc with --noEmit writes errors to stdout in the form
#   path/to/file.ts(123,45): error TS1234: message
# Reduce to a stable key of `path:line:code` so cosmetic message changes
# don't trip the gate.
set +e
npx tsc --noEmit 2>&1 \
  | grep -E '^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+' \
  | sed -E 's/^([^()]+)\(([0-9]+),[0-9]+\): error (TS[0-9]+).*/\1:\2:\3/' \
  | sort -u > "$current"
set -e

# Reduce baseline to the same key format.
baseline_keys=$(mktemp); trap 'rm -f "$current" "$baseline_keys"' EXIT
grep -E '^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+' "$baseline" \
  | sed -E 's/^([^()]+)\(([0-9]+),[0-9]+\): error (TS[0-9]+).*/\1:\2:\3/' \
  | sort -u > "$baseline_keys"

new_errors=$(comm -23 "$current" "$baseline_keys" || true)

if [[ -n "$new_errors" ]]; then
  echo "charter-tsc: new TypeScript errors not in baseline:" >&2
  echo "$new_errors" >&2
  exit 1
fi

echo "charter-tsc: no new TypeScript errors (current $(wc -l < "$current") vs baseline $(wc -l < "$baseline_keys"))."
exit 0
