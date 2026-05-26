#!/usr/bin/env bash
set -euo pipefail

printf 'Starting OpsUp SuperDoc for OpenWebUI...\n'

if [ ! -f .env ]; then
  cp .env.example .env
  printf '\nCreated .env from .env.example. Edit .env, set WEBUI_SECRET_KEY and your model provider settings, then run ./start.sh again.\n'
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is not installed or not available in PATH.\n'
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker-compose"
else
  printf 'Docker Compose is not installed.\n'
  exit 1
fi

$DOCKER_COMPOSE up -d --build

printf '\nWaiting for services...\n'
sleep 10

check_url() {
  name="$1"
  url="$2"
  if curl -fsS "$url" >/dev/null 2>&1; then
    printf 'OK   %s: %s\n' "$name" "$url"
  else
    printf 'WARN %s is not ready yet: %s\n' "$name" "$url"
  fi
}

check_url "OpenWebUI" "http://localhost:${OPENWEBUI_PORT:-3000}"
check_url "SuperDoc" "http://localhost:${SUPERDOC_PORT:-8081}/health"
check_url "HTTP bridge" "http://localhost:${MCP_PORT:-8082}/health"

cat <<MSG

Services started.
OpenWebUI: http://localhost:${OPENWEBUI_PORT:-3000}
SuperDoc:  http://localhost:${SUPERDOC_PORT:-8081}

Next: install openwebui-integration/superdoc_tool.py in OpenWebUI Workspace -> Tools.
MSG
