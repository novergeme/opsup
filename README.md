# OpsUp - AI Document Editor Platform

Professional AI-powered document editing platform combining OpenWebUI chat interface with SuperDoc document rendering and editing capabilities.

## Features

- 📄 **DOCX Document Support** - Upload, view, edit, and create .docx files
- 🤖 **AI-Powered Editing** - Use LLM models to analyze and edit documents
- 💬 **Chat Interface** - OpenWebUI-based chat for document commands
- 🔍 **RAG Integration** - Retrieval-Augmented Generation for document analysis
- 🎨 **Visual Document Editor** - SuperDoc renders documents in browser
- 🚀 **Cross-Platform** - Deploy on macOS, Linux, or cloud
- 📊 **Admin Dashboard** - Model management, API keys, settings
- 🔌 **MCP Server** - AI agent integration for automated workflows

## Quick Start

### Prerequisites
- Docker & Docker Compose
- 8GB RAM minimum (16GB recommended)
- API key for your preferred LLM provider (OpenAI, Anthropic, or local Ollama)

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd opsup
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env and add your API keys
```

3. Start the platform:
```bash
# macOS
./start.sh

# Linux/Ubuntu
./start.sh
```

4. Access the platform:
- OpenWebUI: http://localhost:3000
- SuperDoc Editor: Integrated in OpenWebUI artifacts

## Architecture

The platform consists of:

1. **OpenWebUI** - Chat interface and AI orchestration
2. **SuperDoc** - DOCX rendering and editing engine
3. **MCP Server** - AI agent tool integration
4. **RAG Pipeline** - Document embedding and retrieval
5. **Document Service** - File upload/storage management

## Usage

### Upload and Edit Existing Document
1. Upload .docx file via chat interface
2. Document renders in SuperDoc viewer
3. Send editing prompts (e.g., "rewrite this more professionally")
4. AI processes changes and updates document

### Create New Document
1. Send creation prompt (e.g., "create a car sale contract")
2. AI generates document content
3. Document opens in SuperDoc editor
4. Continue refining via chat

### Document Analysis
1. Upload document for analysis
2. Ask questions about content
3. Get AI-powered insights and summaries

## Configuration

### Environment Variables

See `.env.example` for all available options.

Key settings:
- `OPENAI_API_KEY` - OpenAI API key (or use Ollama)
- `OLLAMA_BASE_URL` - Local Ollama instance
- `SUPERDOC_LICENSE_KEY` - SuperDoc license (if required)
- `RAG_VECTOR_DB` - Vector database for embeddings

### Supported Models

- OpenAI: GPT-4, GPT-3.5-turbo
- Anthropic: Claude 3 (Opus, Sonnet, Haiku)
- Local: Ollama (Llama 3, Mistral, etc.)
- Any OpenAI-compatible API

## Production Deployment

### Ubuntu/Linux

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh

# Configure and start
cp .env.example .env
./deploy.sh
```

### Cloud Deployment

1. Provision server (AWS, GCP, DigitalOcean)
2. Install Docker
3. Clone repo and configure
4. Run deployment script
5. Configure reverse proxy (nginx provided)

## Monetization

### Business Models

1. **SaaS Platform**
   - Monthly subscription per user
   - Pay-per-document pricing
   - Enterprise plans

2. **Self-Hosted License**
   - One-time license fee
   - Annual support contract
   - Custom integrations

3. **API Access**
   - Usage-based pricing
   - White-label solutions

### Pricing Suggestions

- Starter: $29/month (50 documents)
- Professional: $99/month (unlimited)
- Enterprise: Custom pricing

## Development

### Local Development

```bash
docker-compose -f docker-compose.dev.yml up
```

### Building Custom Images

```bash
docker-compose build
```

## API Endpoints

### Document Upload
```
POST /api/documents/upload
Content-Type: multipart/form-data
```

### Document Edit
```
POST /api/documents/{id}/edit
{
  "prompt": "Make it more formal",
  "model": "gpt-4"
}
```

### Document Create
```
POST /api/documents/create
{
  "prompt": "Create a service agreement",
  "template": "contract"
}
```

## Support

- Documentation: [Wiki]
- Issues: [GitHub Issues]
- Email: support@opsup.ai

## License

Commercial License - See LICENSE file

---

Built with ❤️ by OpsUp Team
