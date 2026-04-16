# OpsUp Setup Guide

Complete guide to install, configure, and run your AI Document Editor platform.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start (5 minutes)](#quick-start)
3. [Configuration](#configuration)
4. [AI/LLM Setup](#aillm-setup)
5. [Testing the Platform](#testing)
6. [Production Deployment](#production)
7. [Monetization](#monetization)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites {#prerequisites}

### Required Software

**macOS:**
```bash
# Install Docker Desktop for Mac
brew install --cask docker
```

**Ubuntu/Linux:**
```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Install Docker Compose (if not included)
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### System Requirements

- **RAM**: 8GB minimum, 16GB recommended
- **CPU**: 2+ cores
- **Disk**: 20GB+ free space
- **Network**: For API access to AI models

---

## Quick Start (5 minutes) {#quick-start}

### Step 1: Clone or Navigate to Project

```bash
cd /path/to/opsup
```

### Step 2: Configure Environment

```bash
# Copy example configuration
cp .env.example .env

# Edit the file
nano .env  # or use your preferred editor
```

### Step 3: Add Your API Key

**Option A: OpenAI (Recommended for testing)**
```bash
# In .env file, set:
OPENAI_API_KEY=sk-your-openai-key-here
```

Get your key from: https://platform.openai.com/api-keys

**Option B: Use Local Ollama (Free)**
```bash
# In .env file, uncomment these lines:
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODELS=llama3
```

**Option C: Anthropic Claude**
```bash
# In .env file, set:
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Get your key from: https://console.anthropic.com/settings/keys

### Step 4: Start the Platform

**macOS and Linux:**
```bash
chmod +x start.sh
./start.sh
```

**Windows (PowerShell):**
```powershell
docker-compose up -d
```

### Step 5: Access the Platform

Open your browser and go to:
```
http://localhost:3000
```

Create your admin account when prompted.

---

## Configuration {#configuration}

### Environment Variables Explained

```bash
# OpenWebUI Settings
OPENWEBUI_PORT=3000                    # Port for web interface
WEBUI_SECRET_KEY=change-this           # Session encryption key

# AI Provider (choose ONE)
OPENAI_API_KEY=sk-...                  # OpenAI API key
ANTHROPIC_API_KEY=sk-ant-...           # Anthropic API key
OLLAMA_BASE_URL=http://ollama:11434    # Local Ollama

# SuperDoc Settings
SUPERDOC_PORT=8081                     # Document service port
MAX_FILE_SIZE=50MB                     # Max upload size

# RAG Settings
CHROMA_PORT=8000                       # Vector database port
RAG_EMBEDDING_MODEL=text-embedding-ada-002
```

### Changing Ports

If port 3000 is already in use:
```bash
# In .env file:
OPENWEBUI_PORT=3001

# Then restart:
./stop.sh
./start.sh
```

---

## AI/LLM Setup {#aillm-setup}

### Option 1: OpenAI (Easiest)

1. Create account at https://platform.openai.com
2. Go to API Keys section
3. Create new API key
4. Add to `.env`:
   ```bash
   OPENAI_API_KEY=sk-proj-your-key-here
   ```

**Supported Models:**
- GPT-4 Turbo (best quality)
- GPT-4
- GPT-3.5 Turbo (fastest, cheapest)

### Option 2: Local Ollama (Free, Private)

1. Install Ollama:
   ```bash
   # macOS
   brew install ollama
   
   # Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ```

2. Pull a model:
   ```bash
   ollama pull llama3
   # or
   ollama pull mistral
   ```

3. Start Ollama:
   ```bash
   ollama serve
   ```

4. Configure `.env`:
   ```bash
   OLLAMA_BASE_URL=http://host.docker.internal:11434
   ```

### Option 3: Anthropic Claude

1. Create account at https://console.anthropic.com
2. Get API key
3. Add to `.env`:
   ```bash
   ANTHROPIC_API_KEY=sk-ant-your-key
   ```

**Supported Models:**
- Claude 3 Opus (best)
- Claude 3 Sonnet (balanced)
- Claude 3 Haiku (fastest)

---

## Testing the Platform {#testing}

### Test 1: Upload and View Document

1. Open http://localhost:3000
2. Click "Upload Document"
3. Select a .docx file
4. Verify it displays in the viewer

### Test 2: AI Document Editing

1. Upload a document
2. In chat, type:
   ```
   Make this document more professional
   ```
3. Wait for AI to process
4. Verify changes in document viewer

### Test 3: Create Document from Prompt

1. In chat, type:
   ```
   Create a car sale contract for a 2020 Tesla Model 3, price $35,000
   ```
2. Wait for document generation
3. Verify document opens in viewer
4. Download if needed

### Test 4: Document Analysis

1. Upload a document
2. In chat, type:
   ```
   Summarize this document and list key points
   ```
3. Review AI analysis

### Test 5: API Endpoints

```bash
# Check health
curl http://localhost:8081/health

# List documents
curl http://localhost:8081/api/documents

# Test MCP server
curl http://localhost:8082/health
```

---

## Production Deployment {#production}

### Deploy to Ubuntu Server

#### 1. Provision Server

- AWS EC2 (t3.medium or larger)
- DigitalOcean Droplet
- Linode
- Minimum: 2 CPU, 8GB RAM, 50GB SSD

#### 2. Connect to Server

```bash
ssh user@your-server-ip
```

#### 3. Install Dependencies

```bash
sudo apt update
sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

#### 4. Clone Repository

```bash
git clone https://github.com/your-org/opsup.git
cd opsup
```

#### 5. Configure

```bash
cp .env.example .env
nano .env

# Update with your settings:
# - Add API keys
# - Change domain name
# - Increase security
```

#### 6. Deploy

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```

#### 7. Configure Domain & SSL

Install Certbot for free SSL:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Update `nginx.conf` with your domain:
```nginx
server_name your-domain.com;
```

Restart nginx:
```bash
docker-compose -f docker-compose.yml --profile production restart nginx
```

### Backup Strategy

```bash
# Backup Docker volumes
docker run --rm -v opsup_documents:/data -v $(pwd):/backup alpine tar czf /backup/documents-backup.tar.gz -C /data .

# Backup database
docker run --rm -v opsup_openwebui_data:/data -v $(pwd):/backup alpine tar czf /backup/openwebui-backup.tar.gz -C /data .
```

### Monitoring

```bash
# View logs
docker-compose logs -f openwebui
docker-compose logs -f superdoc
docker-compose logs -f mcp-server

# Check resource usage
docker stats
```

---

## Monetization {#monetization}

### Business Model 1: SaaS Platform

**Setup:**
1. Deploy on cloud server
2. Set up billing (Stripe recommended)
3. Create pricing page

**Pricing Tiers:**
```
Starter:       $29/month  - 50 docs, 1 user
Professional:  $99/month  - Unlimited, 5 users
Enterprise:    $299/month - White-label, API
```

**Features to Highlight:**
- ✅ AI-powered editing
- ✅ Professional templates
- ✅ RAG-based document analysis
- ✅ Secure document storage
- ✅ Export to multiple formats

### Business Model 2: Self-Hosted License

**Target Customers:**
- Law firms
- Real estate agencies
- Consulting companies
- Enterprises

**Sales Strategy:**
1. Create landing page
2. Offer free trial/demo
3. Provide migration support
4. Annual maintenance contracts

### Business Model 3: API Service

Offer document AI API to developers:
```
Free tier:     100 requests/month
Developer:     $49/month - 5,000 requests
Business:      $199/month - 50,000 requests
Enterprise:    Custom pricing
```

### Marketing Channels

1. **Product Hunt** - Launch announcement
2. **Twitter/X** - Build in public updates
3. **LinkedIn** - B2B targeting
4. **Reddit** - r/SaaS, r/Entrepreneur
5. **YouTube** - Demo videos
6. **SEO** - Blog about AI documents

### Key Metrics to Track

- MRR (Monthly Recurring Revenue)
- Churn rate
- Customer acquisition cost (CAC)
- Lifetime value (LTV)
- Active users (DAU/MAU)

---

## Troubleshooting {#troubleshooting}

### Platform Won't Start

**Check Docker:**
```bash
docker ps -a
docker-compose logs
```

**Common Issues:**
- Port already in use → Change ports in `.env`
- Out of memory → Increase Docker memory limit
- Permission denied → Run with sudo or fix permissions

### AI Not Working

**Verify API Key:**
```bash
# Test OpenAI
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

**Check Logs:**
```bash
docker-compose logs superdoc | grep -i error
```

**Verify Configuration:**
- Ensure at least one AI provider is configured
- Check API key is valid
- Verify network connectivity

### Document Upload Fails

**Check File Type:**
- Only .docx and .doc supported
- File must be under MAX_FILE_SIZE

**Check Storage:**
```bash
docker volume ls
docker volume inspect opsup_documents
```

### RAG Not Working

**Verify ChromaDB:**
```bash
curl http://localhost:8000/api/v1/heartbeat
```

**Check Embeddings:**
- Ensure OPENAI_API_KEY is set (for OpenAI embeddings)
- Or configure local embedding model

### Performance Issues

**Optimize Docker:**
```bash
# Increase Docker resources
# macOS: Docker Desktop → Settings → Resources
# Linux: Edit /etc/docker/daemon.json
```

**Database Optimization:**
```bash
# Compact volumes
docker system prune -a --volumes
```

---

## Support & Resources

- **Documentation**: This guide
- **Issues**: GitHub Issues
- **Email**: support@opsup.ai
- **Community**: Discord/Slack (setup your own)

---

## Next Steps

1. ✅ Platform running
2. Configure AI provider
3. Test all features
4. Deploy to production
5. Set up billing
6. Launch and market!

Good luck with your AI document editing business! 🚀
