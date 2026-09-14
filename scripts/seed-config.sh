#!/usr/bin/env bash
# Siembra la configuración por defecto (sección 13) si la tabla está vacía: el motor la crea
# al primer acceso, así que alcanza con pedir el texto de consentimiento a la API.
# Uso: ./scripts/seed-config.sh <apiBaseUrl>
set -euo pipefail
BASE="${1:?Uso: ./scripts/seed-config.sh <apiBaseUrl>}"
curl -sS "${BASE%/}/v1/consent/text" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("config sembrada · textVersion", d["textVersion"])'
