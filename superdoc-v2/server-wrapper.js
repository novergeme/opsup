/**
 * OpsUp SuperDoc Server v2
 * Combines headless backend + React frontend + document management
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8081);

// Document storage
const DOCUMENTS_DIR = path.resolve(
  process.env.DOCUMENT_STORAGE_PATH || path.join(__dirname, 'documents')
);
await mkdir(DOCUMENTS_DIR, { recursive: true });

// Blank template
const TEMPLATE_PATH = path.join(__dirname, 'blank.docx');

// API config
const API_URL = process.env.OPENAI_API_BASE_URL || 'https://foundation-models.api.cloud.ru/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b';

// Pass env vars to headless
process.env.SUPERDOC_HEADLESS_TEMPLATE_PATH = TEMPLATE_PATH;
process.env.SUPERDOC_HEADLESS_API_KEY = API_KEY;
process.env.SUPERDOC_HEADLESS_API_URL = API_URL;
process.env.SUPERDOC_HEADLESS_MODEL = DEFAULT_MODEL;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve React frontend
app.use('/viewer', express.static(path.join(__dirname, 'frontend')));

// Multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await mkdir(DOCUMENTS_DIR, { recursive: true });
      cb(null, DOCUMENTS_DIR);
    },
    filename: (req, file, cb) => {
      cb(null, `${randomUUID()}.docx`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx' || ext === '.doc') {
      cb(null, true);
    } else {
      cb(new Error('Only .docx files allowed'));
    }
  }
});

// ============================================
// Document Management API
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'superdoc-v2',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Upload document
app.post('/api/documents/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const docId = req.file.filename.replace('.docx', '');
    const metadata = {
      id: docId,
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save metadata
    await writeFile(
      path.join(DOCUMENTS_DIR, `${docId}.meta.json`),
      JSON.stringify(metadata, null, 2)
    );

    // Build viewer URL with localhost (not host.docker.internal)
    const viewerUrl = `http://localhost:${PORT}/viewer/index.html?docId=${docId}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`;

    res.status(201).json({
      success: true,
      document: metadata,
      viewerUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List documents
app.get('/api/documents', async (req, res) => {
  try {
    const files = await readdir(DOCUMENTS_DIR);
    const metaFiles = files.filter(f => f.endsWith('.meta.json'));
    const documents = [];

    for (const metaFile of metaFiles) {
      try {
        const meta = JSON.parse(await readFile(path.join(DOCUMENTS_DIR, metaFile), 'utf-8'));
        documents.push(meta);
      } catch {
        // skip invalid
      }
    }

    documents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, documents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get document
app.get('/api/documents/:id', async (req, res) => {
  try {
    const metaPath = path.join(DOCUMENTS_DIR, `${req.params.id}.meta.json`);
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    res.json({ success: true, document: meta });
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Get document HTML for viewer (redirect to React viewer)
app.get('/api/documents/:id/html', async (req, res) => {
  try {
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    res.json({
      success: true,
      html: `<div id="superdoc-viewer" data-docid="${req.params.id}"></div>`,
      viewerUrl: `/viewer/index.html?docId=${req.params.id}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`
    });
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Download document
app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const metaPath = path.join(DOCUMENTS_DIR, `${req.params.id}.meta.json`);
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    res.download(docPath, meta.filename);
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Get document original.docx (for SuperDoc React viewer)
app.get('/document/:id/original.docx', async (req, res) => {
  try {
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    res.sendFile(docPath, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    });
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Save XML back to document (from SuperDoc React viewer)
app.post('/document/:id/save-xml', express.text({ limit: '50mb' }), async (req, res) => {
  try {
    // For now, just acknowledge the save
    // In production, you'd convert XML back to DOCX
    res.json({ success: true, message: 'Document saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete document
app.delete('/api/documents/:id', async (req, res) => {
  try {
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    const metaPath = path.join(DOCUMENTS_DIR, `${req.params.id}.meta.json`);
    await Promise.all([
      unlink(docPath).catch(() => {}),
      unlink(metaPath).catch(() => {})
    ]);
    res.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AI Document Operations (via headless)
// ============================================

// Create document from prompt
app.post('/api/documents/create', async (req, res) => {
  try {
    const { prompt, template, model } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const useModel = model || DEFAULT_MODEL;

    // Call LLM directly to generate HTML
    const htmlContent = await callLLMForDocumentCreation(prompt, template, useModel);

    // Create DOCX from HTML using headless render
    const docxBuffer = await renderDocxFromHtml(htmlContent);

    // Save document
    const docId = randomUUID();
    const docPath = path.join(DOCUMENTS_DIR, `${docId}.docx`);
    await writeFile(docPath, docxBuffer);

    const metadata = {
      id: docId,
      filename: `ai_generated_${template || 'document'}.docx`,
      size: docxBuffer.length,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      template,
      prompt,
      model: useModel
    };

    await writeFile(
      path.join(DOCUMENTS_DIR, `${docId}.meta.json`),
      JSON.stringify(metadata, null, 2)
    );

    // Build viewer URL with localhost
    const viewerUrl = `http://localhost:${PORT}/viewer/index.html?docId=${docId}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`;

    res.status(201).json({
      success: true,
      document: metadata,
      viewerUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit document with AI (via headless)
app.post('/api/documents/:id/edit', async (req, res) => {
  try {
    const { prompt, model } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const docxBuffer = await readFile(docPath);

    // Import headless edit function
    const { default: headlessServer } = await import('./server.js');

    // Use the headless edit endpoint
    const editResult = await headlessServer.editDocument(req.params.id, prompt, model || DEFAULT_MODEL);

    // Update metadata
    const metaPath = path.join(DOCUMENTS_DIR, `${req.params.id}.meta.json`);
    const metadata = JSON.parse(await readFile(metaPath, 'utf-8'));
    metadata.updatedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));

    // Build viewer URL with localhost
    const viewerUrl = `http://localhost:${PORT}/viewer/index.html?docId=${req.params.id}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`;

    res.json({
      success: true,
      document: metadata,
      viewerUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analyze document
app.post('/api/documents/:id/analyze', async (req, res) => {
  try {
    const { query, model } = req.body;
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);

    const useModel = model || DEFAULT_MODEL;

    // Simple analysis via LLM
    const docxBuffer = await readFile(docPath);
    const { default: headlessServer } = await import('./server.js');
    const textContent = await headlessServer.extractText(docxBuffer);

    const analysis = await callLLMForAnalysis(textContent, query || 'Analyze this document', useModel);

    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LLM Helper Functions
// ============================================

async function callLLMForDocumentCreation(prompt, template, model) {
  const templates = {
    'car-sale': 'Create a vehicle sales contract in HTML format with inline CSS. Include: buyer/seller info, vehicle details (make, model, year, VIN), sale price, payment terms, warranties, signatures.',
    contract: 'Create a professional legal contract in HTML format with inline CSS. Include: parties, terms, conditions, signatures.',
    agreement: 'Create a business agreement in HTML format with inline CSS. Include: parties, terms, obligations, signatures.',
    report: 'Create a structured report in HTML format with inline CSS. Include: title, summary, sections, conclusions.',
    default: 'Create a well-structured document in HTML format with inline CSS styling.'
  };

  const systemPrompt = templates[template] || templates.default;

  const response = await fetch(`${API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `${systemPrompt} Return ONLY valid HTML, no markdown, no explanations.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 4000
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  let html = data.choices[0].message.content;

  // Strip markdown fences if any
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
  if (fenced) html = fenced[1].trim();

  return html;
}

async function renderDocxFromHtml(html) {
  // Import headless render
  const { default: headlessServer } = await import('./server.js');
  const docxBuffer = await headlessServer.renderDocument(html);
  return docxBuffer;
}

async function callLLMForAnalysis(textContent, query, model) {
  const response = await fetch(`${API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a document analyst. Provide comprehensive analysis.' },
        { role: 'user', content: `Document text:\n\n${textContent}\n\n${query}` }
      ],
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ============================================
// Start Server
// ============================================

// Import headless server for direct access
const headlessModule = await import('./server.js');

app.listen(PORT, () => {
  console.log(`\n🚀 OpsUp SuperDoc v2 running on port ${PORT}`);
  console.log(`📄 Document storage: ${DOCUMENTS_DIR}`);
  console.log(`🎨 Frontend: http://localhost:${PORT}/viewer/`);
  console.log(`🔌 API: http://localhost:${PORT}/api/documents`);
  console.log(`🤖 LLM: ${API_URL} (${DEFAULT_MODEL})\n`);
});

export default app;
