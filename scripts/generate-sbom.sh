#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?usage: generate-sbom.sh IMAGE [OUTPUT]}"
OUTPUT="${2:-sbom.spdx.json}"

if command -v syft >/dev/null 2>&1; then
  syft "$IMAGE" -o "spdx-json=$OUTPUT"
  echo "Wrote SBOM to $OUTPUT (syft)"
  exit 0
fi

if docker sbom "$IMAGE" --format spdx-json >"$OUTPUT" 2>/dev/null; then
  echo "Wrote SBOM to $OUTPUT (docker sbom)"
  exit 0
fi

echo "Install syft (https://github.com/anchore/syft) or use Docker with SBOM support." >&2
exit 1
