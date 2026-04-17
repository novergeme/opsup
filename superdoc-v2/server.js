/**
 * OpsUp SuperDoc Server v2
 * Headless document editing + React frontend + Document management
 * Based on superdoc-headless + superdoc-react
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, access, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import dotenv from 'dotenv';
import { JSDOM } from 'jsdom';
import { Editor } from 'superdoc/super-editor';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

// Config
const PORT = Number(process.env.SUPERDOC_PORT || process.env.PORT || 8081);
const DOCUMENTS_DIR = process.env.DOCUMENT_STORAGE_PATH || path.join(__dirname, 'documents');
const TEMPLATE_PATH = path.join(__dirname, 'blank.docx');
const API_URL = process.env.OPENAI_API_BASE_URL || 'https://foundation-models.api.cloud.ru/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || process.env.SUPERDOC_HEADLESS_MODEL || 'openai/gpt-oss-120b';
const LLM_TIMEOUT_MS = Number(process.env.SUPERDOC_HEADLESS_TIMEOUT_MS || 120000);
const LLM_MAX_TOKENS = Number(process.env.SUPERDOC_HEADLESS_MAX_TOKENS || 5000);
const toBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};
const DISABLE_INTERNAL_LLM_PROMPT_ROUTES = toBoolean(process.env.DISABLE_INTERNAL_LLM_PROMPT_ROUTES, true);
const MAX_APPLY_ACTIONS = 50;

// Create docs dir
await mkdir(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve React frontend at /viewer
app.use('/viewer', express.static(path.join(__dirname, 'frontend')));

// Multer for uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await mkdir(DOCUMENTS_DIR, { recursive: true });
      cb(null, DOCUMENTS_DIR);
    },
    filename: (req, file, cb) => cb(null, `${randomUUID()}.docx`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx') cb(null, true);
    else cb(new Error('Only .docx files'));
  }
});

const uploadInMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ============================================
// Helpers
// ============================================

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const normalizeWhitespace = (v) => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getViewerUrl = (docId) =>
  `/viewer/index.html?docId=${docId}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`;

const toBuffer = async (buf) => {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf);
  if (buf?.type === 'Buffer' && Array.isArray(buf.data)) return Buffer.from(buf.data);
  throw new Error('Unsupported DOCX payload');
};

function createHeadlessDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const prev = {
    window: globalThis.window, document: globalThis.document,
    DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer,
    Node: globalThis.Node, HTMLElement: globalThis.HTMLElement,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return {
    document: dom.window.document,
    restore: () => {
      Object.assign(globalThis, prev);
      dom.window.close();
    }
  };
}

const getEditorPlainText = (editor) => {
  try {
    const doc = editor?.state?.doc;
    const size = doc?.content?.size ?? 0;
    if (!doc || size <= 0 || typeof doc.textBetween !== 'function') return '';
    return String(doc.textBetween(0, size, '\n', '\n'));
  } catch { return ''; }
};

const stripFences = (content) => {
  const match = String(content || '').match(/```(?:html|json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : String(content || '').trim();
};

const normalizeHtmlInput = (value) => {
  const raw = stripFences(value);
  if (!raw) throw new Error('HTML content is required');

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return raw;
  }

  return raw
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
};

async function withHeadlessEditor(docxBuffer, fn) {
  const domEnv = createHeadlessDom();
  let editor = null;
  try {
    editor = await Editor.open(docxBuffer, {
      isHeadless: true, document: domEnv.document,
      suppressDefaultDocxStyles: true,
      user: { name: 'AI Assistant', email: 'ai@local' },
    });
    return await fn(editor);
  } finally {
    if (editor) editor.destroy();
    domEnv.restore();
  }
}

async function renderDocument(html) {
  const templateBuf = await readFile(TEMPLATE_PATH);
  const domEnv = createHeadlessDom();
  const editor = await Editor.open(templateBuf, {
    isHeadless: true, document: domEnv.document,
    suppressDefaultDocxStyles: true,
    user: { name: 'AI Assistant', email: 'ai@local' },
  });
  try {
    editor.commands.insertContent(html, { contentType: 'html' });
    const buf = await editor.exportDocx({ isFinalDoc: true, commentsType: 'clean' });
    return await toBuffer(buf);
  } finally {
    editor.destroy();
    domEnv.restore();
  }
}

async function replaceDocumentContent(docxBuffer, html, options = {}) {
  const normalizedHtml = normalizeHtmlInput(html);
  const trackChanges = Boolean(options?.trackChanges);
  return await withHeadlessEditor(docxBuffer, async (editor) => {
    if (trackChanges) {
      editor.commands.enableTrackChanges?.();
    }

    if (typeof editor?.commands?.selectAll === 'function') {
      editor.commands.selectAll();
    } else {
      const size = editor?.state?.doc?.content?.size ?? 1;
      editor?.commands?.setTextSelection?.({ from: 1, to: Math.max(1, size) });
    }

    const inserted = editor?.commands?.insertContent?.(normalizedHtml, { contentType: 'html' });
    if (inserted === false) throw new Error('Failed to replace document content');

    const buf = await editor.exportDocx(
      trackChanges
        ? { isFinalDoc: false, commentsType: 'external' }
        : { isFinalDoc: true, commentsType: 'clean' }
    );
    return await toBuffer(buf);
  });
}

async function extractText(docxBuffer) {
  return await withHeadlessEditor(docxBuffer, (editor) => getEditorPlainText(editor));
}

const buildSearchCandidates = (findText) => {
  const raw = String(findText || '').trim();
  if (!raw) return [];
  const n = normalizeWhitespace(raw);
  return [...new Set([raw, n, n.replace(/ /g, '\u00a0'), raw.replace(/\u00a0/g, ' ')].filter(Boolean))];
};

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const buildTextWindow = (text, offset, maxChars) => {
  const source = String(text || '');
  const totalChars = source.length;
  const safeOffset = Math.min(Math.max(offset, 0), totalChars);
  const safeMaxChars = Math.max(maxChars, 1);
  const end = Math.min(totalChars, safeOffset + safeMaxChars);
  return {
    text: source.slice(safeOffset, end),
    total_chars: totalChars,
    offset: safeOffset,
    max_chars: safeMaxChars,
    truncated: end < totalChars,
  };
};

const searchTextMatches = (text, query, maxResults = 20, contextChars = 200) => {
  const source = String(text || '');
  const normalizedText = source.replace(/\u00a0/g, ' ');
  const normalizedQuery = String(query || '').replace(/\u00a0/g, ' ').trim();
  if (!normalizedQuery) return [];

  const haystack = normalizedText.toLowerCase();
  const needle = normalizedQuery.toLowerCase();
  const matches = [];
  let fromIndex = 0;

  while (matches.length < maxResults) {
    const start = haystack.indexOf(needle, fromIndex);
    if (start === -1) break;
    const end = start + needle.length;
    const snippetStart = Math.max(0, start - contextChars);
    const snippetEnd = Math.min(source.length, end + contextChars);

    matches.push({
      index: matches.length,
      start,
      end,
      snippet: source.slice(snippetStart, snippetEnd),
    });

    fromIndex = Math.max(start + 1, end);
  }

  return matches;
};

const applyHeadlessActions = async (editor, actions) => {
  const warnings = [];
  let applied = 0, units = 0;
  for (const action of actions || []) {
    const type = String(action?.type || '').trim();
    try {
      if (type === 'replace' || type === 'replaceAll') {
        const find = String(action?.find || '').trim();
        const replace = String(action?.replace || '');
        if (!find) { warnings.push(`empty find for ${type}`); continue; }
        const candidates = buildSearchCandidates(find);
        let count = 0;
        for (const c of candidates) {
          const matches = editor?.commands?.search?.(c, { highlight: false }) || [];
          if (!Array.isArray(matches) || matches.length === 0) continue;
          const targets = type === 'replaceAll' ? matches : [matches[0]];
          let replacedForCandidate = 0;
          for (const t of [...targets].sort((a, b) => (b.from || 0) - (a.from || 0))) {
            if (typeof t?.from !== 'number' || typeof t?.to !== 'number') continue;
            editor?.commands?.setTextSelection?.({ from: t.from, to: t.to });
            if (editor?.commands?.insertContent?.(replace || '') !== false) replacedForCandidate++;
          }
          if (replacedForCandidate > 0) {
            count = replacedForCandidate;
            editor?.commands?.search?.('', { highlight: false });
            break;
          }
        }
        editor?.commands?.search?.('', { highlight: false });
        if (count > 0) { applied++; units += count; }
        else warnings.push(`${type}: "${find.slice(0, 80)}" not found`);
      } else if (type === 'insertContent') {
        const content = String(action?.content || '').trim();
        if (!content) { warnings.push('empty insertContent'); continue; }
        const pos = action?.position === 'start' ? 1 : Math.max(1, editor?.state?.doc?.content?.size ?? 1);
        if (action?.position === 'start' || action?.position === 'end')
          editor?.commands?.setTextSelection?.({ from: pos, to: pos });
        if (editor?.commands?.insertContent?.(content, { contentType: 'html' }) !== false) { applied++; units++; }
      } else warnings.push(`unknown action: ${type}`);
    } catch (e) { warnings.push(`action error ${type}: ${e.message}`); }
  }
  return { applied, units, warnings };
};

async function callLLM(messages, temperature = 0.3, maxTokens = 4000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, temperature, max_tokens: maxTokens, messages }),
      signal: controller.signal,
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`LLM ${res.status}: ${t}`); }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(tid); }
}

async function readDocumentMeta(docId) {
  return JSON.parse(await readFile(path.join(DOCUMENTS_DIR, `${docId}.meta.json`), 'utf-8'));
}

async function writeDocumentMeta(docId, meta) {
  await writeFile(path.join(DOCUMENTS_DIR, `${docId}.meta.json`), JSON.stringify(meta, null, 2));
}

async function saveRenderedDocument({
  docId = randomUUID(),
  filename = 'ai_generated_document.docx',
  docxBuffer,
  meta = {},
}) {
  await writeFile(path.join(DOCUMENTS_DIR, `${docId}.docx`), docxBuffer);

  const documentMeta = {
    id: docId,
    filename,
    size: docxBuffer.length,
    mimetype: DOCX_MIME,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...meta,
  };

  await writeDocumentMeta(docId, documentMeta);
  return documentMeta;
}

// ============================================
// API Routes
// ============================================

// Health
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'superdoc-v2', timestamp: new Date().toISOString() })
);

// Upload
app.post('/api/documents/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const docId = req.file.filename.replace('.docx', '');
    const requestedFilename = String(req.body?.filename || '').trim();
    const meta = {
      id: docId, filename: requestedFilename || req.file.originalname, size: req.file.size,
      mimetype: DOCX_MIME, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await writeFile(path.join(DOCUMENTS_DIR, `${docId}.meta.json`), JSON.stringify(meta, null, 2));
    res.status(201).json({ success: true, document: meta, viewerUrl: getViewerUrl(docId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List
app.get('/api/documents', async (req, res) => {
  try {
    const files = await readdir(DOCUMENTS_DIR);
    const docs = [];
    for (const f of files.filter(f => f.endsWith('.meta.json'))) {
      try { docs.push(JSON.parse(await readFile(path.join(DOCUMENTS_DIR, f), 'utf-8'))); } catch {}
    }
    docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, documents: docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get doc
app.get('/api/documents/:id', async (req, res) => {
  try {
    const meta = await readDocumentMeta(req.params.id);
    res.json({ success: true, document: meta });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// Get extracted text for prompt-based workflows in OpenWebUI
app.get('/api/documents/:id/text', async (req, res) => {
  try {
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const meta = await readDocumentMeta(req.params.id);
    const text = await extractText(await readFile(docPath));
    const offset = clampInt(req.query?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = clampInt(req.query?.max_chars, Math.max(text.length, 1), 1, 2_000_000);
    const window = buildTextWindow(text, offset, maxChars);

    res.json({
      success: true,
      document: meta,
      text: window.text,
      total_chars: window.total_chars,
      offset: window.offset,
      max_chars: window.max_chars,
      truncated: window.truncated,
      viewerUrl: getViewerUrl(req.params.id),
    });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.post('/api/documents/:id/search-text', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const maxResults = clampInt(req.body?.max_results, 20, 1, 100);
    const contextChars = clampInt(req.body?.context_chars, 200, 0, 5000);

    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);

    const text = await extractText(await readFile(docPath));
    const matches = searchTextMatches(text, query, maxResults, contextChars);

    res.json({
      success: true,
      document_id: req.params.id,
      total_chars: text.length,
      matches,
    });
  } catch (e) {
    if (e?.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Get HTML preview
app.get('/api/documents/:id/html', async (req, res) => {
  try {
    await access(path.join(DOCUMENTS_DIR, `${req.params.id}.docx`));
    res.json({ success: true, viewerUrl: getViewerUrl(req.params.id) });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// Download
app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const p = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(p);
    const meta = await readDocumentMeta(req.params.id);
    res.download(p, meta.filename);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// Delete
app.delete('/api/documents/:id', async (req, res) => {
  try {
    await unlink(path.join(DOCUMENTS_DIR, `${req.params.id}.docx`)).catch(() => {});
    await unlink(path.join(DOCUMENTS_DIR, `${req.params.id}.meta.json`)).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SuperDoc React viewer routes
app.get('/document/:id/original.docx', async (req, res) => {
  try {
    const p = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(p);
    res.sendFile(p, { headers: { 'Content-Type': DOCX_MIME } });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.post('/document/:id/save-xml', express.text({ limit: '50mb' }), async (req, res) => {
  res.json({ success: true });
});

app.post('/document/:id/save', uploadInMemory.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing file payload' });
    }

    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    await writeFile(docPath, req.file.buffer);

    const meta = await readDocumentMeta(req.params.id);
    meta.size = req.file.buffer.length;
    meta.updatedAt = new Date().toISOString();
    await writeDocumentMeta(req.params.id, meta);

    res.json({
      success: true,
      document: meta,
      viewerUrl: getViewerUrl(req.params.id),
    });
  } catch (e) {
    if (e?.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Create document from provided HTML without calling an internal LLM
app.post('/api/documents/create-from-html', async (req, res) => {
  try {
    const { html, filename, metadata } = req.body || {};
    const normalizedHtml = normalizeHtmlInput(html);
    const docxBuffer = await renderDocument(normalizedHtml);
    const docId = randomUUID();
    const documentMeta = await saveRenderedDocument({
      docId,
      filename: String(filename || 'ai_generated_document.docx'),
      docxBuffer,
      meta: { ...(metadata || {}) },
    });

    res.status(201).json({
      success: true,
      document: documentMeta,
      viewerUrl: getViewerUrl(docId),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replace an existing document with provided HTML without calling an internal LLM
app.post('/api/documents/:id/replace-html', async (req, res) => {
  try {
    const { html, filename, metadata } = req.body || {};
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);

    const updatedBuffer = await replaceDocumentContent(await readFile(docPath), html, {
      trackChanges: true,
    });
    await writeFile(docPath, updatedBuffer);

    const meta = await readDocumentMeta(req.params.id);
    if (filename) meta.filename = String(filename);
    if (metadata && typeof metadata === 'object') {
      meta.metadata = { ...(meta.metadata || {}), ...metadata };
    }
    meta.size = updatedBuffer.length;
    meta.updatedAt = new Date().toISOString();
    await writeDocumentMeta(req.params.id, meta);

    res.json({
      success: true,
      document: meta,
      viewerUrl: getViewerUrl(req.params.id),
      text: await extractText(updatedBuffer),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/documents/:id/apply-actions', async (req, res) => {
  try {
    const { actions, filename, metadata } = req.body || {};
    const strict = toBoolean(req.body?.strict, true);
    if (!Array.isArray(actions)) {
      return res.status(400).json({ error: 'actions must be an array' });
    }
    if (actions.length > MAX_APPLY_ACTIONS) {
      return res.status(400).json({ error: `actions limit exceeded; max ${MAX_APPLY_ACTIONS}` });
    }

    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const originalBuffer = await readFile(docPath);

    const result = await withHeadlessEditor(originalBuffer, async (editor) => {
      editor.commands.enableTrackChanges?.();
      const changes = await applyHeadlessActions(editor, actions);
      if (changes.applied <= 0) return { ...changes, updatedBuffer: null };
      const buf = await editor.exportDocx({ isFinalDoc: false, commentsType: 'external' });
      return { ...changes, updatedBuffer: await toBuffer(buf) };
    });

    if (strict && result.applied <= 0) {
      return res.status(409).json({
        success: false,
        error: 'No actions applied',
        warnings: result.warnings || [],
      });
    }

    const finalBuffer = result.updatedBuffer || originalBuffer;
    if (result.updatedBuffer) {
      await writeFile(docPath, finalBuffer);
    }

    const meta = await readDocumentMeta(req.params.id);
    if (filename) meta.filename = String(filename);
    if (metadata && typeof metadata === 'object') {
      meta.metadata = { ...(meta.metadata || {}), ...metadata };
    }
    meta.size = finalBuffer.length;
    meta.updatedAt = new Date().toISOString();
    await writeDocumentMeta(req.params.id, meta);

    res.json({
      success: true,
      document: meta,
      viewerUrl: getViewerUrl(req.params.id),
      changes: {
        applied: result.applied,
        units: result.units,
        warnings: result.warnings || [],
      },
      text: await extractText(finalBuffer),
    });
  } catch (e) {
    if (e?.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Create document from prompt
app.post('/api/documents/create', async (req, res) => {
  const started = Date.now();
  try {
    const { prompt, template, model, html: htmlContent, filename, metadata } = req.body || {};

    if (!htmlContent && prompt && DISABLE_INTERNAL_LLM_PROMPT_ROUTES) {
      return res.status(400).json({
        error: 'prompt-based path disabled; use html-based endpoints',
        hint: 'Use POST /api/documents/create-from-html or send html payload to /api/documents/create',
      });
    }

    if (htmlContent) {
      const normalizedHtml = normalizeHtmlInput(htmlContent);
      const docxBuffer = await renderDocument(normalizedHtml);
      const docId = randomUUID();
      const documentMeta = await saveRenderedDocument({
        docId,
        filename: String(filename || `ai_generated_${template || 'document'}.docx`),
        docxBuffer,
        meta: {
          template,
          prompt,
          model: model || DEFAULT_MODEL,
          ...(metadata || {}),
        },
      });

      return res.status(201).json({ success: true, document: documentMeta, viewerUrl: getViewerUrl(docId) });
    }

    if (!prompt) return res.status(400).json({ error: 'Prompt or html required' });

    const templates = {
      'car-sale': 'Create a vehicle sales contract in HTML with inline CSS. Include: buyer/seller info, vehicle details (make, model, year, VIN), price, payment terms, warranties, signatures.',
      contract: 'Create a legal contract in HTML with inline CSS. Include: parties, terms, conditions, signatures.',
      agreement: 'Create a business agreement in HTML with inline CSS. Include: parties, terms, obligations, signatures.',
      default: 'Create a professional document in HTML with inline CSS.',
    };
    const sysPrompt = templates[template] || templates.default;

    console.log(`[${new Date().toISOString()}] Creating document with template: ${template}`);

    let generatedHtml = await callLLM([
      { role: 'system', content: `${sysPrompt} Return ONLY valid HTML, no markdown.` },
      { role: 'user', content: prompt }
    ], 0.3, 4000);

    generatedHtml = stripFences(generatedHtml);
    console.log(`HTML generated (${generatedHtml.length} chars), rendering to DOCX...`);

    const docxBuffer = await renderDocument(generatedHtml);
    const docId = randomUUID();
    const meta = await saveRenderedDocument({
      docId,
      filename: String(filename || `ai_generated_${template || 'document'}.docx`),
      docxBuffer,
      meta: {
        template,
        prompt,
        model: model || DEFAULT_MODEL,
        ...(metadata || {}),
      },
    });

    console.log(`Document created: ${docId} (${(Date.now() - started)}ms)`);
    res.status(201).json({ success: true, document: meta, viewerUrl: getViewerUrl(docId) });
  } catch (e) {
    console.error('Create error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Edit document
app.post('/api/documents/:id/edit', async (req, res) => {
  const started = Date.now();
  try {
    const { prompt, html, filename, metadata } = req.body || {};
    if (!prompt && !html) return res.status(400).json({ error: 'Prompt or html required' });
    if (!html && prompt && DISABLE_INTERNAL_LLM_PROMPT_ROUTES) {
      return res.status(400).json({
        error: 'prompt-based path disabled; use html-based endpoints',
        hint: 'Use POST /api/documents/:id/replace-html or send html payload to /api/documents/:id/edit',
      });
    }

    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const docxBuffer = await readFile(docPath);

    if (html) {
      const updatedBuffer = await replaceDocumentContent(docxBuffer, html, {
        trackChanges: true,
      });
      await writeFile(docPath, updatedBuffer);

      const meta = await readDocumentMeta(req.params.id);
      if (filename) meta.filename = String(filename);
      if (metadata && typeof metadata === 'object') {
        meta.metadata = { ...(meta.metadata || {}), ...metadata };
      }
      meta.size = updatedBuffer.length;
      meta.updatedAt = new Date().toISOString();
      await writeDocumentMeta(req.params.id, meta);

      return res.json({
        success: true,
        document: meta,
        viewerUrl: getViewerUrl(req.params.id),
        changes: { mode: 'html-replace' },
      });
    }

    const textBefore = await extractText(docxBuffer);

    console.log(`[${new Date().toISOString()}] Editing doc ${req.params.id}: "${prompt.slice(0, 50)}..."`);

    // Get action plan from LLM
    const planText = await callLLM([
      {
        role: 'system',
        content: `You are a document editing assistant. Return ONLY JSON with actions array.
Actions: replace, replaceAll, insertContent.
For replace: {"type":"replace","find":"exact text","replace":"new text"}
For insertContent: {"type":"insertContent","content":"<p>html</p>","position":"end"}
Max 8 actions. Return: {"summary":"...","actions":[...]}`
      },
      {
        role: 'user',
        content: `Edit request: ${prompt}\n\nDocument text:\n${textBefore.slice(0, 15000)}`
      }
    ], 0.1, 2000);

    const plan = JSON.parse(stripFences(planText));
    const actions = plan.actions || [];

    if (actions.length === 0) {
      return res.status(400).json({ error: 'No edit actions generated', plan });
    }

    // Apply actions
    const result = await withHeadlessEditor(docxBuffer, async (editor) => {
      editor.commands.enableTrackChanges?.();
      const { applied, units, warnings } = await applyHeadlessActions(editor, actions);
      if (applied === 0) throw new Error('No actions applied');
      const buf = await editor.exportDocx({ isFinalDoc: false, commentsType: 'external' });
      return { buf: await toBuffer(buf), applied, units, warnings };
    });

    // Save updated doc
    await writeFile(docPath, result.buf);
    const meta = await readDocumentMeta(req.params.id);
    meta.size = result.buf.length;
    meta.updatedAt = new Date().toISOString();
    await writeDocumentMeta(req.params.id, meta);

    console.log(`Document edited: ${result.applied} actions (${(Date.now() - started)}ms)`);
    res.json({ success: true, document: meta, viewerUrl: getViewerUrl(req.params.id), changes: result });
  } catch (e) {
    console.error('Edit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Analyze
app.post('/api/documents/:id/analyze', async (req, res) => {
  try {
    const { query } = req.body;
    const docPath = path.join(DOCUMENTS_DIR, `${req.params.id}.docx`);
    await access(docPath);
    const text = await extractText(await readFile(docPath));
    const analysis = await callLLM([
      { role: 'system', content: 'Analyze this document comprehensively.' },
      { role: 'user', content: `${query || 'Summarize and list key points'}\n\n${text.slice(0, 15000)}` }
    ], 0.3, 2000);
    res.json({ success: true, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 OpsUp SuperDoc v2`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📄 Documents: ${DOCUMENTS_DIR}`);
  console.log(`🎨 Viewer: http://localhost:${PORT}/viewer/`);
  console.log(`🤖 LLM: ${API_URL} (${DEFAULT_MODEL})\n`);
  console.log(`🔒 Prompt routes disabled: ${DISABLE_INTERNAL_LLM_PROMPT_ROUTES}`);
});
