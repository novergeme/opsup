#!/bin/bash

# ============================================
# OpsUp AI Document Editor - Deploy Script
# ============================================
# For production deployment on Linux/Ubuntu

set -e

echo "🚀 Deploying OpsUp AI Document Editor Platform for Production..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root or with sudo${NC}"
    exit 1
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  Creating .env from .env.example...${NC}"
    cp .env.example .env
    echo -e "${RED}❌ Please configure .env file before continuing${NC}"
    exit 1
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo -e "${BLUE}📦 Installing Docker...${NC}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}✓ Docker installed${NC}"
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    echo -e "${BLUE}📦 Installing Docker Compose...${NC}"
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo -e "${GREEN}✓ Docker Compose installed${NC}"
fi

# Create SSL directory
mkdir -p ssl

# Generate self-signed certificate if SSL certs don't exist
if [ ! -f ssl/cert.pem ] || [ ! -f ssl/key.pem ]; then
    echo -e "${YELLOW}⚠️  Generating self-signed SSL certificate...${NC}"
    echo -e "${YELLOW}   For production, replace with your own SSL certificate${NC}"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout ssl/key.pem \
        -out ssl/cert.pem \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost" 2>/dev/null
    echo -e "${GREEN}✓ SSL certificate generated${NC}"
fi

# Determine docker compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

# Build and deploy
echo ""
echo -e "${BLUE}📦 Building and deploying...${NC}"

$DOCKER_COMPOSE -f docker-compose.yml --profile production up -d

# Wait for services
echo ""
echo -e "${YELLOW}⏳ Waiting for services to start...${NC}"
sleep 15

# Configure firewall
if command -v ufw &> /dev/null; then
    echo -e "${BLUE}🔒 Configuring firewall...${NC}"
    ufw allow 80/tcp
    ufw allow 443/tcp
    echo -e "${GREEN}✓ Firewall configured${NC}"
fi

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo -e "${BLUE}📍 Your platform is available at:${NC}"
echo -e "   HTTP:  http://your-server-ip"
echo -e "   HTTPS: https://your-server-ip"
echo ""
echo -e "${YELLOW}⚠️  Important:${NC}"
echo -e "   1. Update nginx.conf with your domain name"
echo -e "   2. Replace self-signed SSL with Let's Encrypt or commercial cert"
echo -e "   3. Configure proper DNS for your domain"
echo -e "   4. Set up backup strategy for /var/lib/docker/volumes"
echo ""
echo -e "${BLUE}📚 Documentation: README.md${NC}"
echo ""
