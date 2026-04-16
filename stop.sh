#!/bin/bash

# ============================================
# OpsUp - Stop Script
# ============================================

set -e

echo "🛑 Stopping OpsUp Platform..."

# Determine docker compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

$DOCKER_COMPOSE down

echo "✅ Platform stopped"
