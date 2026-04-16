#!/bin/bash

# ============================================
# OpsUp AI Document Editor - Start Script
# ============================================

set -e

echo "🚀 Starting OpsUp AI Document Editor Platform..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file not found. Creating from .env.example...${NC}"
    cp .env.example .env
    echo -e "${RED}❌ Please edit .env file with your configuration before starting.${NC}"
    echo -e "${YELLOW}   At minimum, set OPENAI_API_KEY or configure OLLAMA_BASE_URL${NC}"
    exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    echo -e "${BLUE}   macOS: https://docs.docker.com/desktop/install/mac-install/${NC}"
    echo -e "${BLUE}   Linux: https://docs.docker.com/engine/install/${NC}"
    exit 1
fi

# Check if Docker Compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed.${NC}"
    exit 1
fi

# Determine docker compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

echo -e "${BLUE}📦 Building and starting services...${NC}"

# Stop any running services
$DOCKER_COMPOSE down 2>/dev/null || true

# Build and start services
$DOCKER_COMPOSE up -d --build

# Wait for services to be ready
echo ""
echo -e "${YELLOW}⏳ Waiting for services to start...${NC}"
sleep 15

# Check health of services
echo ""
echo -e "${BLUE}🔍 Checking service health...${NC}"

SERVICES=("openwebui:3000" "superdoc:8081" "mcp-server:8082")

for service in "${SERVICES[@]}"; do
    name=${service%%:*}
    port=${service##*:}
    
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:$port | grep -q "200\|301\|302"; then
        echo -e "${GREEN}✓ $name is running on port $port${NC}"
    else
        echo -e "${YELLOW}⚠ $name may still be starting (port $port)${NC}"
    fi
done

echo ""
echo -e "${GREEN}✅ Platform started successfully!${NC}"
echo ""
echo -e "${BLUE}📍 Access points:${NC}"
echo -e "   OpenWebUI:    http://localhost:3000"
echo -e "   SuperDoc API: http://localhost:8081"
echo -e "   MCP Server:   http://localhost:8082"
echo ""
echo -e "${YELLOW}📝 Next steps:${NC}"
echo -e "   1. Open http://localhost:3000 in your browser"
echo -e "   2. Create your admin account"
echo -e "   3. Configure your AI model (OpenAI API key or Ollama)"
echo -e "   4. Start uploading and editing documents!"
echo ""
echo -e "${BLUE}📚 For more information, see README.md${NC}"
echo ""
