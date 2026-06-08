#!/usr/bin/env bash
set -euo pipefail

if [[ -f /usr/lib/bashio/bashio ]]; then
  # shellcheck source=/dev/null
  source /usr/lib/bashio/bashio
else
  bashio::log.info() { echo "[info] $*"; }
  bashio::log.warning() { echo "[warn] $*"; }
  bashio::log.fatal() { echo "[fatal] $*"; exit 1; }
  bashio::config() { jq -r --arg key "$1" '.[$key] // empty' /data/options.json; }
  bashio::services.available() { return 1; }
fi

option() {
  local key="$1"
  local value
  value="$(bashio::config "$key" 2>/dev/null || true)"
  if [[ "$value" == "null" ]]; then
    value=""
  fi
  printf '%s' "$value"
}

SOURCE_REPO="$(option source_repo)"
SOURCE_REF="$(option source_ref)"
AUTO_UPDATE="$(option auto_update)"
MYSQL_URL_OVERRIDE="$(option mysql_url)"
DATABASE="$(option database)"
RUN_INIT_DB="$(option run_init_db)"
MAX_PAGES_PER_REGION="$(option max_pages_per_region)"

SOURCE_REPO="${SOURCE_REPO:-https://github.com/ivanlee1007/land591-finder-skill.git}"
SOURCE_REF="${SOURCE_REF:-main}"
AUTO_UPDATE="${AUTO_UPDATE:-true}"
DATABASE="${DATABASE:-land591}"
RUN_INIT_DB="${RUN_INIT_DB:-true}"
MAX_PAGES_PER_REGION="${MAX_PAGES_PER_REGION:-20}"

REPO_DIR="/data/land591-finder-skill"
APP_DIR="${REPO_DIR}/assets/591-land-finder"

bashio::log.info "Starting 591 Land Finder add-on"
bashio::log.info "Source: ${SOURCE_REPO} (${SOURCE_REF})"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  rm -rf "${REPO_DIR}"
  bashio::log.info "Cloning Land Finder source"
  git clone --depth=1 --branch "${SOURCE_REF}" "${SOURCE_REPO}" "${REPO_DIR}"
elif [[ "${AUTO_UPDATE}" == "true" ]]; then
  bashio::log.info "Updating Land Finder source"
  git -C "${REPO_DIR}" fetch origin "${SOURCE_REF}" --depth=1
  git -C "${REPO_DIR}" checkout -q "FETCH_HEAD"
fi

if [[ ! -d "${APP_DIR}" ]]; then
  bashio::log.fatal "Land Finder app directory not found: ${APP_DIR}"
fi

if [[ -n "${MYSQL_URL_OVERRIDE}" ]]; then
  export MYSQL_URL="${MYSQL_URL_OVERRIDE}"
elif bashio::services.available "mysql"; then
  MYSQL_HOST="$(bashio::services mysql host)"
  MYSQL_PORT="$(bashio::services mysql port)"
  MYSQL_USER="$(bashio::services mysql username)"
  MYSQL_PASSWORD="$(bashio::services mysql password)"
  MYSQL_PORT="${MYSQL_PORT:-3306}"
  export MYSQL_URL="mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DATABASE}"
else
  bashio::log.fatal "MariaDB service credentials were not provided. Start the MariaDB add-on or set the mysql_url option."
fi

export PORT="5910"
export MAX_PAGES_PER_REGION="${MAX_PAGES_PER_REGION}"
export NODE_ENV="production"

bashio::log.info "Installing npm dependencies if needed"
cd "${APP_DIR}"
if [[ ! -d node_modules ]]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

# The upstream Express server currently binds to 127.0.0.1. In an add-on,
# ingress/direct port access must be reachable from outside the Node process,
# so patch the runtime checkout to bind to all container interfaces.
if grep -q "app.listen(PORT, '127.0.0.1'" src/server.js; then
  bashio::log.info "Patching Express bind address for Home Assistant ingress"
  sed -i "s/app.listen(PORT, '127.0.0.1'/app.listen(PORT, '0.0.0.0'/" src/server.js
fi

if [[ "${RUN_INIT_DB}" == "true" ]]; then
  bashio::log.info "Initializing database schema"
  npm run init-db
fi

bashio::log.info "Launching Land Finder on port ${PORT}"
exec npm run serve
