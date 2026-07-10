#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# VitalPulse CloudCare API – Deployment Orchestrator
#
# This script packages and deploys the CloudFormation/SAM stack for the
# serverless REST/GraphQL API.  It compiles Java sources, runs the test suite,
# packages Lambda artifacts, uploads them to S3, and performs an idempotent
# CloudFormation deploy.  It was designed to be invoked from CI/CD pipelines,
# but it can also be run interactively by engineers with the correct IAM role.
#
# Usage:
#   ./deploy.sh -e <dev|staging|prod> [-r <aws-region>] [-p <aws-profile>] \
#               [-s <s3_bucket>] [-v <version_override>] [--skip-tests]
#
# Example:
#   ./deploy.sh -e staging -r us-east-1 -p vitalpulse-dev
#
# Prerequisites:
#   • AWS CLI v2 with a configured profile or role
#   • JDK 17+ and Maven Wrapper
#   • AWS SAM CLI
#   • jq (for JSON parsing)
# ---------------------------------------------------------------------------

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly DEFAULT_REGION="us-east-1"
readonly DEFAULT_PROFILE="default"
readonly DEFAULT_STACK_NAME="vitalpulse-cloudcare-api"
readonly DEFAULT_SAM_TEMPLATE="${PROJECT_ROOT}/infra/cf/template.yaml"
readonly DEFAULT_BUILD_DIR="${PROJECT_ROOT}/build"
readonly GRADLEW="${PROJECT_ROOT}/gradlew"
readonly MVNW="${PROJECT_ROOT}/mvnw"
readonly TIMESTAMP="$(date '+%Y%m%d%H%M%S')"

# ---------------
# Logging helpers
# ---------------
_log() { echo -e "$(date '+%Y-%m-%d %H:%M:%S') | ${1:-INFO} | ${2:-}" >&2; }
log()  { _log "INFO"  "$*"; }
warn() { _log "WARN"  "$*"; }
err()  { _log "ERROR" "$*"; }

# ------------------------
# Error/Exit trap handling
# ------------------------
function cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    err "Deployment aborted (exit code ${exit_code})."
  fi
  exit $exit_code
}
trap cleanup EXIT

# ------------
# Usage banner
# ------------
usage() {
  cat <<EOF
VitalPulse CloudCare API – Deploy Script

Options:
  -e, --env           Target environment: dev | staging | prod   (required)
  -r, --region        AWS region              (default: ${DEFAULT_REGION})
  -p, --profile       AWS CLI profile         (default: ${DEFAULT_PROFILE})
  -s, --s3-bucket     S3 bucket for artifacts (default: vp-cloudcare-artifacts-\${env})
  -v, --version       Override application version (default: derive from Git)
      --stack-name    CloudFormation stack name (default: ${DEFAULT_STACK_NAME})
      --skip-tests    Skip unit/integration tests
  -h, --help          Show this help message

Environment Variables (override CLI args):
  CI                   When set, enables non-interactive mode (useful in CI)
  MAVEN_SKIP_TESTS     Maven flag to skip tests (same as --skip-tests)

EOF
}

# -------------------
# Argument processing
# -------------------
ENVIRONMENT=""
REGION="${DEFAULT_REGION}"
PROFILE="${DEFAULT_PROFILE}"
S3_BUCKET=""
STACK_NAME="${DEFAULT_STACK_NAME}"
VERSION_OVERRIDE=""
SKIP_TESTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--env)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    -r|--region)
      REGION="${2:-}"
      shift 2
      ;;
    -p|--profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    -s|--s3-bucket)
      S3_BUCKET="${2:-}"
      shift 2
      ;;
    -v|--version)
      VERSION_OVERRIDE="${2:-}"
      shift 2
      ;;
    --stack-name)
      STACK_NAME="${2:-}"
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${ENVIRONMENT}" ]]; then
  err "Missing required argument: -e | --env"
  usage
  exit 1
fi

# Validate environment
if ! [[ "${ENVIRONMENT}" =~ ^(dev|staging|prod)$ ]]; then
  err "Invalid environment '${ENVIRONMENT}'. Must be dev, staging, or prod."
  exit 1
fi

# Derive defaults based on environment
S3_BUCKET="${S3_BUCKET:-vp-cloudcare-artifacts-${ENVIRONMENT}}"
STACK_NAME="${STACK_NAME}-${ENVIRONMENT}"

# ------------------------
# External dependency check
# ------------------------
require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    err "Missing required command '$1'. Install it and retry."
    exit 1
  }
}
require_bin "aws"
require_bin "sam"
require_bin "jq"
require_bin "git"

# ------------------------
# Application versioning
# ------------------------
derive_version() {
  local git_sha git_branch
  git_sha="$(git rev-parse --short HEAD)"
  git_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
  echo "${VERSION_OVERRIDE:-${git_branch}-${git_sha}-${TIMESTAMP}}"
}
APP_VERSION="$(derive_version)"
log "Deploying version: ${APP_VERSION}"

# ----------------------------
# Build/Package Java Artifacts
# ----------------------------
build_java() {
  log "Building Java artifacts..."
  if [[ -f "${GRADLEW}" ]]; then
    (
      cd "${PROJECT_ROOT}"
      if [[ "${SKIP_TESTS}" == true ]]; then
        ./gradlew clean build -x test
      else
        ./gradlew clean build
      fi
    )
  elif [[ -f "${MVNW}" ]]; then
    (
      cd "${PROJECT_ROOT}"
      if [[ "${SKIP_TESTS}" == true ]]; then
        MAVEN_SKIP_TESTS=true ./mvnw -B clean package -DskipTests
      else
        ./mvnw -B clean verify
      fi
    )
  else
    err "No build wrapper (Gradle/Maven) found."
    exit 1
  fi
}
build_java

# ---------------------------------------------
# Provision artifact bucket if it doesn't exist
# ---------------------------------------------
ensure_artifact_bucket() {
  if ! aws s3api head-bucket --bucket "${S3_BUCKET}" --profile "${PROFILE}" --region "${REGION}" 2>/dev/null; then
    log "Creating S3 artifact bucket: ${S3_BUCKET} (region: ${REGION})"
    aws s3api create-bucket \
      --bucket "${S3_BUCKET}" \
      --acl private \
      --create-bucket-configuration LocationConstraint="${REGION}" \
      --profile "${PROFILE}" \
      --region "${REGION}"
  fi
}
ensure_artifact_bucket

# -----------------------------------
# Package & Deploy CloudFormation/SAM
# -----------------------------------
PACKAGE_TEMPLATE="${DEFAULT_BUILD_DIR}/packaged-${ENVIRONMENT}.yaml"

package_stack() {
  log "Packaging SAM template..."
  sam package \
    --template-file "${DEFAULT_SAM_TEMPLATE}" \
    --s3-bucket "${S3_BUCKET}" \
    --output-template-file "${PACKAGE_TEMPLATE}" \
    --region "${REGION}" \
    --profile "${PROFILE}"
}
deploy_stack() {
  log "Deploying CloudFormation stack: ${STACK_NAME}"
  sam deploy \
    --template-file "${PACKAGE_TEMPLATE}" \
    --stack-name "${STACK_NAME}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        Environment="${ENVIRONMENT}" \
        ArtifactBucket="${S3_BUCKET}" \
        ApplicationVersion="${APP_VERSION}" \
    --region "${REGION}" \
    --profile "${PROFILE}" \
    --no-fail-on-empty-changeset
}
package_stack
deploy_stack

# -----------------------------
# Post-deployment notifications
# -----------------------------
stack_outputs() {
  log "Retrieving stack outputs..."
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs" \
    --output table \
    --region "${REGION}" \
    --profile "${PROFILE}"
}
announce_success() {
  log "✅  Deployment completed successfully for '${ENVIRONMENT}' environment 🎉"
}
stack_outputs
announce_success