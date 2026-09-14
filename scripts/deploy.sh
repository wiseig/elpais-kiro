#!/usr/bin/env bash
# Despliegue de Preguntale a El País (baseline 8.1): ./scripts/deploy.sh <app|--all> <env>
# apps: data | engine | jobs | channels | backoffice | --all      env: dev | prod
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-}"
ENV_NAME="${2:-}"
EXPECTED_ACCOUNT="178042202224"
EXPECTED_REGION="us-east-1"
AWS_PROFILE_NAME="${AWS_PROFILE:-dailybrief}"

if [[ -z "${APP}" || -z "${ENV_NAME}" ]]; then
  echo "Uso: ./scripts/deploy.sh <data|engine|jobs|channels|backoffice|--all> <dev|prod>"
  exit 1
fi
if [[ "${ENV_NAME}" != "dev" && "${ENV_NAME}" != "prod" ]]; then
  echo "Error: env debe ser dev o prod."
  exit 1
fi

cd "${ROOT_DIR}"
if [[ -f ".env.${ENV_NAME}" ]]; then set -a; source ".env.${ENV_NAME}"; set +a; fi

# Node 22 y pnpm vía corepack (la máquina puede tener otro Node por defecto).
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then source "${HOME}/.nvm/nvm.sh"; nvm use 22 >/dev/null || true; fi
PNPM="corepack pnpm"

# Cuenta y región únicas (sección 15). Nunca desplegar en otra cuenta.
command -v aws >/dev/null || { echo "Error: falta aws cli."; exit 1; }
ACTUAL_ACCOUNT="$(aws sts get-caller-identity --profile "${AWS_PROFILE_NAME}" --query Account --output text 2>/dev/null || true)"
if [[ -z "${ACTUAL_ACCOUNT}" ]]; then
  echo "Error: no hay sesión AWS válida para el perfil ${AWS_PROFILE_NAME}. Corré: aws login --profile ${AWS_PROFILE_NAME}"
  exit 1
fi
if [[ "${ACTUAL_ACCOUNT}" != "${EXPECTED_ACCOUNT}" ]]; then
  echo "Error: cuenta ${ACTUAL_ACCOUNT}; se requiere ${EXPECTED_ACCOUNT}."
  exit 1
fi
ACTUAL_REGION="$(aws configure get region --profile "${AWS_PROFILE_NAME}" || true)"
if [[ "${ACTUAL_REGION}" != "${EXPECTED_REGION}" ]]; then
  echo "Error: región ${ACTUAL_REGION:-sin configurar}; se requiere ${EXPECTED_REGION}."
  exit 1
fi
export AWS_PROFILE="${AWS_PROFILE_NAME}" AWS_REGION="${EXPECTED_REGION}" AWS_DEFAULT_REGION="${EXPECTED_REGION}"
export CDK_DEFAULT_ACCOUNT="${EXPECTED_ACCOUNT}" CDK_DEFAULT_REGION="${EXPECTED_REGION}"
# El CDK CLI puede no reconocer sesiones de `aws login`; exportar credenciales temporales.
eval "$(aws configure export-credentials --profile "${AWS_PROFILE_NAME}" --format env 2>/dev/null || true)"

CONTEXT=(-c "env=${ENV_NAME}")
[[ -n "${PELP_ALERT_EMAIL:-}" ]] && CONTEXT+=(-c "alertEmail=${PELP_ALERT_EMAIL}")
[[ -n "${PELP_COGNITO_CLIENT_ID:-}" ]] && CONTEXT+=(-c "cognitoClientId=${PELP_COGNITO_CLIENT_ID}")
[[ -n "${PELP_ALLOWED_ORIGIN:-}" ]] && CONTEXT+=(-c "allowedOrigin=${PELP_ALLOWED_ORIGIN}")
[[ "${DEV_SHUTDOWN:-}" == "true" ]] && CONTEXT+=(-c "devShutdown=true")
# Paso intermedio al cambiar corpusRevision: conserva el data source anterior (ver runbook).
[[ "${KEEP_PREVIOUS_DATA_SOURCE:-}" == "true" ]] && CONTEXT+=(-c "keepPreviousDataSource=true")

build_spa() {
  echo "==> build $1"
  ${PNPM} --filter "$1" build
}

deploy_stacks() {
  echo "==> cdk deploy $*"
  (cd infrastructure && npx cdk deploy "$@" "${CONTEXT[@]}" --require-approval never)
}

${PNPM} install --frozen-lockfile
${PNPM} typecheck

case "${APP}" in
  data) deploy_stacks "pelp-data-${ENV_NAME}" ;;
  engine) build_spa @pelp/chat-web; deploy_stacks "pelp-engine-${ENV_NAME}" ;;
  jobs) deploy_stacks "pelp-jobs-${ENV_NAME}" ;;
  channels) deploy_stacks "pelp-channels-${ENV_NAME}" ;;
  backoffice) build_spa @pelp/backoffice; deploy_stacks "pelp-backoffice-${ENV_NAME}" ;;
  --all)
    build_spa @pelp/chat-web
    build_spa @pelp/backoffice
    deploy_stacks "pelp-data-${ENV_NAME}" "pelp-engine-${ENV_NAME}" "pelp-jobs-${ENV_NAME}" "pelp-channels-${ENV_NAME}" "pelp-backoffice-${ENV_NAME}"
    ;;
  *) echo "App desconocida: ${APP}"; exit 1 ;;
esac

echo "==> listo. Outputs:"
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName, 'pelp-') && ends_with(StackName, '-${ENV_NAME}')].{stack:StackName,outputs:Outputs[].{k:OutputKey,v:OutputValue}}" --output json
