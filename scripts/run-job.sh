#!/usr/bin/env bash
# Invoca un job Lambda de forma síncrona y muestra el resultado.
# Uso: ./scripts/run-job.sh <sync-feed|reconcile-api|backfill|profiler|evals|bias-report|costs|ingestion-status> <dev|prod> ['{"json":"payload"}']
set -euo pipefail
JOB="${1:-}"; ENV_NAME="${2:-}"; PAYLOAD="${3:-{\}}"
[[ -z "${JOB}" || -z "${ENV_NAME}" ]] && { echo "Uso: ./scripts/run-job.sh <job> <dev|prod> [payload]"; exit 1; }
SUFFIX=""; [[ "${ENV_NAME}" == "dev" ]] && SUFFIX="-dev"
OUT="$(mktemp)"
aws lambda invoke --function-name "pelp-job-${JOB}${SUFFIX}" --cli-binary-format raw-in-base64-out --payload "${PAYLOAD}" --profile "${AWS_PROFILE:-dailybrief}" --region us-east-1 "${OUT}" >/dev/null
cat "${OUT}"; echo; rm -f "${OUT}"
