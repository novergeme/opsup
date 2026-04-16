# OpsUp Quick Start Guide

## ✅ What's Working NOW!

Your platform is **partially running**:

### Active Services:
- ✅ **SuperDoc API**: http://localhost:8081
- ✅ **MCP Server**: http://localhost:8082

### To Check Status:
```bash
docker ps
curl http://localhost:8081/health
curl http://localhost:8082/health
```

---

## 🚀 Next Steps to Complete Setup

### Option 1: Install OpenWebUI Manually (Recommended)

OpenWebUI is a large download (~1.5GB). Run this command:

```bash
# Make sure you're in the opsup directory
cd /Users/novergeme/Desktop/Projects/opsup

# Run OpenWebUI container
docker run -d \
  --name opsup-openwebui \
  -p 3000:8080 \
  -v openwebui_data:/app/backend/data \
  -e OPENAI_API_KEY=your-key-here \
  -e WEBUI_SECRET_KEY=my-secret-key-123 \
  --network opsup_opsup-network \
  --add-host=host.docker.internal:host-gateway \
  -e SUPERDOC_API_URL=http://host.docker.internal:8081 \
  -e OPENAI_API_BASE_URL=https://api.openai.com/v1 \
  ghcr.io/open-webui/open-webui:latest
```

**Wait for it to download** (5-10 minutes depending on internet speed)

Then access: **http://localhost:3000**

---

### Option 2: Test Without OpenWebUI (Use API Directly)

You can test the platform right now using the API:

#### 1. Test SuperDoc API:
```bash
# Check health
curl http://localhost:8081/health

# List documents (should be empty initially)
curl http://localhost:8081/api/documents
```

#### 2. Upload a Document:
```bash
# You need a .docx file to test
curl -X POST http://localhost:8081/api/documents/upload \
  -F "document=@/path/to/your/document.docx"
```

#### 3. Create a Document with AI:
```bash
curl -X POST http://localhost:8081/api/documents/create \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a car sale contract for a 2020 Tesla Model 3, price $35,000",
    "template": "car-sale",
    "model": "gpt-4"
  }'
```

#### 4. View MCP Server Tools:
```bash
# List available tools
curl http://localhost:8082/mcp/tools

# Create document via MCP
curl -X POST http://localhost:8082/mcp/tools/create_document/execute \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a simple business agreement",
    "template": "agreement"
  }'
```

---

## 📝 Important: Configure Your API Key

Make sure your `.env` file has your OpenAI API key:

```bash
# Open the file
nano .env

# Make sure this line has your real API key:
OPENAI_API_KEY=sk-your-actual-key-here
```

Get your key from: https://platform.openai.com/api-keys

---

## 🔍 Troubleshooting

### Check if services are running:
```bash
docker ps
```

### View logs:
```bash
# SuperDoc logs
docker logs opsup-superdoc

# MCP Server logs
docker logs opsup-mcp-server

# OpenWebUI logs (if installed)
docker logs opsup-openwebui
```

### Restart services:
```bash
# Restart SuperDoc and MCP
docker restart opsup-superdoc opsup-mcp-server

# Restart OpenWebUI
docker restart opsup-openwebui
```

### Stop everything:
```bash
docker stop opsup-superdoc opsup-mcp-server opsup-openwebui
```

---

## 📊 Current Architecture

```
┌─────────────────────────────────────────┐
│           OpenWebUI (Port 3000)         │
│     Chat Interface (Needs Install)      │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│        SuperDoc API (Port 8081)         │
│   ✅ Document Upload/View/Edit          │
│   ✅ AI Integration (OpenAI/Claude)     │
│   ✅ DOCX Generation                    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│       MCP Server (Port 8082)            │
│   ✅ 8 AI Tools Available               │
│   ✅ Document Operations                │
│   ✅ AI Agent Integration               │
└─────────────────────────────────────────┘
```

---

## 🎯 What You Can Do RIGHT NOW

1. ✅ Test API endpoints (see commands above)
2. ✅ Upload and view documents via API
3. ✅ Create documents with AI via API
4. ✅ Analyze documents with RAG via API
5. ⏳ Use web interface (after OpenWebUI installs)

---

## 🚀 For Production (Ubuntu/Linux)

Once everything works locally, deploy to production:

```bash
# On your Ubuntu server:
git clone <your-repo>
cd opsup
cp .env.example .env
# Edit .env with your API keys
sudo ./deploy.sh
```

---

Need help? Check README.md and SETUP_GUIDE.md
