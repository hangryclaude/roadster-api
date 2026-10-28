#!/usr/bin/env bash
# Runs the Codex review described in docs/CODEX-REVIEW-PROMPT.md and writes the verdict to
# docs/CODEX-REVIEW.md. Needs a logged-in codex CLI (`codex login`). Read-only sandbox: the
# reviewer may run tests but may not edit the tree.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! codex login status >/dev/null 2>&1; then
  echo "codex is not logged in — run: codex login" >&2
  exit 1
fi

MODEL="${CODEX_MODEL:-gpt-6-luna}"
EFFORT="${CODEX_EFFORT:-low}"

codex exec \
  --sandbox read-only \
  --skip-git-repo-check \
  -m "$MODEL" \
  -c "model_reasoning_effort=\"$EFFORT\"" \
  -o docs/CODEX-REVIEW.md \
  - < docs/CODEX-REVIEW-PROMPT.md

echo "wrote docs/CODEX-REVIEW.md"
