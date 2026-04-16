const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { z } = require('zod');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 8082;

// Middleware
app.use(cors());
app.use(express.json());

// Document service URL
const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:8081';
const DOCUMENT_PUBLIC_URL = process.env.DOCUMENT_PUBLIC_URL || 'http://localhost:8081';

function toPublicViewerUrl(viewerUrl) {
  if (!viewerUrl || typeof viewerUrl !== 'string') return viewerUrl;
  const publicBaseUrl = DOCUMENT_PUBLIC_URL.replace(/\/$/, '');
  if (/^https?:\/\//i.test(viewerUrl)) return viewerUrl;
  if (viewerUrl.startsWith('/')) return `${publicBaseUrl}${viewerUrl}`;
  return `${publicBaseUrl}/${viewerUrl}`;
}

function normalizeViewerPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  if (!payload.viewerUrl) {
    return payload;
  }

  return {
    ...payload,
    viewerUrl: toPublicViewerUrl(payload.viewerUrl)
  };
}

// ============================================
// MCP Tool Definitions
// ============================================

const tools = [
  {
    name: 'upload_document',
    description: 'Upload a DOCX document to the system',
    inputSchema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Name of the file' },
        base64Content: { type: 'string', description: 'Base64 encoded DOCX file content' }
      },
      required: ['fileName', 'base64Content']
    }
  },
  {
    name: 'list_documents',
    description: 'List all uploaded documents',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_document',
    description: 'Get document details and metadata',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID' }
      },
      required: ['docId']
    }
  },
  {
    name: 'get_document_text',
    description: 'Get extracted plain text and viewer URL for a document',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID' }
      },
      required: ['docId']
    }
  },
  {
    name: 'edit_document',
    description: 'Update a document with final HTML/text or fall back to legacy prompt-based editing',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID to edit' },
        html: { type: 'string', description: 'Final HTML or plain text to apply directly without an internal LLM call' },
        prompt: { type: 'string', description: 'Editing instructions for AI' },
        filename: { type: 'string', description: 'Optional output filename override' },
        model: { type: 'string', description: 'AI model to use (optional)', default: 'gpt-4' }
      },
      required: ['docId']
    }
  },
  {
    name: 'create_document',
    description: 'Create a document from final HTML/text or fall back to legacy prompt-based creation',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Final HTML or plain text to render directly without an internal LLM call' },
        prompt: { type: 'string', description: 'Description of the document to create' },
        template: { type: 'string', description: 'Document template (contract, car-sale, agreement, report)', default: 'default' },
        fileName: { type: 'string', description: 'Output DOCX filename' },
        model: { type: 'string', description: 'AI model to use (optional)', default: 'gpt-4' }
      },
      required: []
    }
  },
  {
    name: 'analyze_document',
    description: 'Analyze a document and answer questions about its content',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID to analyze' },
        query: { type: 'string', description: 'Question or analysis request' },
        model: { type: 'string', description: 'AI model to use (optional)', default: 'gpt-4' }
      },
      required: ['docId', 'query']
    }
  },
  {
    name: 'download_document',
    description: 'Download a document in DOCX format',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID to download' }
      },
      required: ['docId']
    }
  },
  {
    name: 'delete_document',
    description: 'Delete a document from the system',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID to delete' }
      },
      required: ['docId']
    }
  }
];

// ============================================
// MCP Server Endpoints
// ============================================

// List available tools
app.get('/mcp/tools', (req, res) => {
  res.json({ success: true, tools });
});

// Execute tool
app.post('/mcp/tools/:toolName/execute', async (req, res) => {
  const { toolName } = req.params;
  const params = req.body;

  logger.info(`Executing tool: ${toolName}`, { params });

  try {
    let result;

    switch (toolName) {
      case 'upload_document':
        result = await uploadDocument(params);
        break;

      case 'list_documents':
        result = await listDocuments();
        break;

      case 'get_document':
        result = await getDocument(params);
        break;

      case 'get_document_text':
        result = await getDocumentText(params);
        break;

      case 'edit_document':
        result = await editDocument(params);
        break;

      case 'create_document':
        result = await createDocument(params);
        break;

      case 'analyze_document':
        result = await analyzeDocument(params);
        break;

      case 'download_document':
        result = await downloadDocument(params);
        break;

      case 'delete_document':
        result = await deleteDocument(params);
        break;

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    logger.info(`Tool ${toolName} executed successfully`);
    res.json({ success: true, result });

  } catch (error) {
    logger.error(`Tool ${toolName} failed:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// Tool Implementations
// ============================================

async function uploadDocument({ fileName, base64Content }) {
  const buffer = Buffer.from(base64Content, 'base64');
  
  // Create form data for upload
  const FormData = (await import('form-data')).default;
  const formData = new FormData();
  formData.append('filename', fileName);
  formData.append('document', buffer, {
    filename: fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const response = await axios.post(
    `${DOCUMENT_SERVICE_URL}/api/documents/upload`,
    formData,
    {
      headers: formData.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  return normalizeViewerPayload(response.data);
}

async function listDocuments() {
  const response = await axios.get(`${DOCUMENT_SERVICE_URL}/api/documents`);
  return response.data;
}

async function getDocument({ docId }) {
  const response = await axios.get(`${DOCUMENT_SERVICE_URL}/api/documents/${docId}`);
  return response.data;
}

async function getDocumentText({ docId }) {
  const response = await axios.get(`${DOCUMENT_SERVICE_URL}/api/documents/${docId}/text`);
  return normalizeViewerPayload(response.data);
}

async function editDocument({ docId, prompt, model, html, filename }) {
  if (html) {
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/documents/${docId}/replace-html`,
      {
        html,
        ...(filename ? { filename } : {})
      },
      { timeout: 120000 }
    );
    return normalizeViewerPayload(response.data);
  }

  if (!prompt) {
    throw new Error('Either html or prompt is required');
  }

  const response = await axios.post(
    `${DOCUMENT_SERVICE_URL}/api/documents/${docId}/edit`,
    { prompt, model },
    { timeout: 120000 } // 2 minutes timeout for AI processing
  );
  return normalizeViewerPayload(response.data);
}

async function createDocument({ prompt, template, model, html, fileName, metadata }) {
  if (html) {
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/documents/create-from-html`,
      {
        html,
        ...(fileName ? { filename: fileName } : {}),
        ...(metadata ? { metadata } : {})
      },
      { timeout: 120000 }
    );
    return normalizeViewerPayload(response.data);
  }

  if (!prompt) {
    throw new Error('Either html or prompt is required');
  }

  const response = await axios.post(
    `${DOCUMENT_SERVICE_URL}/api/documents/create`,
    { prompt, template, model },
    { timeout: 120000 }
  );
  return normalizeViewerPayload(response.data);
}

async function analyzeDocument({ docId, query, model }) {
  const response = await axios.post(
    `${DOCUMENT_SERVICE_URL}/api/documents/${docId}/analyze`,
    { query, model },
    { timeout: 120000 }
  );
  return response.data;
}

async function downloadDocument({ docId }) {
  const response = await axios.get(
    `${DOCUMENT_SERVICE_URL}/api/documents/${docId}/download`,
    { responseType: 'arraybuffer' }
  );
  return {
    content: response.data.toString('base64'),
    contentType: response.headers['content-type'],
    filename: response.headers['content-disposition']
  };
}

async function deleteDocument({ docId }) {
  const response = await axios.delete(`${DOCUMENT_SERVICE_URL}/api/documents/${docId}`);
  return response.data;
}

// ============================================
// Health Check
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mcp-server',
    timestamp: new Date().toISOString(),
    tools: tools.length
  });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
  logger.info(`MCP Server running on port ${PORT}`);
  logger.info(`Available tools: ${tools.map(t => t.name).join(', ')}`);
});

module.exports = app;
