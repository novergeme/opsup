/**
 * OpsUp SuperDoc service
 *
 * Deterministic DOCX service for OpenWebUI:
 * - stores uploaded/generated documents
 * - renders the bundled SuperDoc viewer
 * - applies structured edits with Track Changes
 * - persists chat/file/document bindings in the documents volume
 *
 * The OpenWebUI model is the only LLM in the runtime path. This service executes
 * document operations; it does not send prompts to a second model.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, access, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import dotenv from 'dotenv';
import { JSDOM } from 'jsdom';
import { Editor } from 'superdoc/super-editor';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const PORT = Number(process.env.SUPERDOC_PORT || process.env.PORT || 8081);
const DOCUMENTS_DIR = process.env.DOCUMENT_STORAGE_PATH || path.join(__dirname, 'documents');
const TEMPLATE_PATH = path.join(__dirname, 'blank.docx');
const CONTEXT_INDEX_PATH = path.join(DOCUMENTS_DIR, 'context-index.json');
const MAX_APPLY_ACTIONS = Number(process.env.SUPERDOC_MAX_APPLY_ACTIONS || 50);
const MAX_DOCUMENTS_PER_CHAT = Number(process.env.SUPERDOC_MAX_DOCUMENTS_PER_CHAT || 100);

await mkdir(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/viewer', express.static(path.join(__dirname, 'frontend')));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const FILE_ID_PATTERN = /^[a-f0-9-]{36}$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await mkdir(DOCUMENTS_DIR, { recursive: true });
      cb(null, DOCUMENTS_DIR);
    },
    filename: (req, file, cb) => cb(null, `${randomUUID()}.docx`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx') cb(null, true);
    else cb(new Error('Only .docx files are supported'));
  },
});

const uploadInMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const nowIso = () => new Date().toISOString();

const normalizeWhitespace = (value) =>
  String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeDocId = (value) => {
  const docId = String(value || '').trim();
  if (!DOC_ID_PATTERN.test(docId)) throw new Error('Invalid document id');
  return docId;
};

const docPath = (docId) => path.join(DOCUMENTS_DIR, `${safeDocId(docId)}.docx`);
const metaPath = (docId) => path.join(DOCUMENTS_DIR, `${safeDocId(docId)}.meta.json`);

const getViewerUrl = (docId) =>
  `/viewer/index.html?docId=${safeDocId(docId)}&api_url=http://localhost:${PORT}&docs_api_url=http://localhost:${PORT}`;

const stripFences = (content) => {
  const match = String(content || '').match(/```(?:html|json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : String(content || '').trim();
};

const normalizeHtmlInput = (value) => {
  const raw = stripFences(value);
  if (!raw) throw new Error('HTML content is required');

  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;

  return raw
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
};

const toBuffer = async (payload) => {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload?.type === 'Buffer' && Array.isArray(payload.data)) return Buffer.from(payload.data);
  throw new Error('Unsupported DOCX payload');
};

function createHeadlessDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const setGlobal = (key, value) => {
    try {
      globalThis[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    DOMParser: globalThis.DOMParser,
    XMLSerializer: globalThis.XMLSerializer,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    navigator: globalThis.navigator,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };

  setGlobal('window', dom.window);
  setGlobal('document', dom.window.document);
  setGlobal('DOMParser', dom.window.DOMParser);
  setGlobal('XMLSerializer', dom.window.XMLSerializer);
  setGlobal('Node', dom.window.Node);
  setGlobal('HTMLElement', dom.window.HTMLElement);
  setGlobal('navigator', dom.window.navigator);
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  setGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));

  return {
    document: dom.window.document,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) setGlobal(key, value);
      dom.window.close();
    },
  };
}

async function withHeadlessEditor(docxBuffer, fn) {
  const domEnv = createHeadlessDom();
  let editor = null;

  try {
    editor = await Editor.open(docxBuffer, {
      isHeadless: true,
      document: domEnv.document,
      suppressDefaultDocxStyles: true,
      user: { name: 'AI Assistant', email: 'ai@openwebui.local' },
    });
    return await fn(editor);
  } finally {
    if (editor) editor.destroy();
    domEnv.restore();
  }
}

const getEditorPlainText = (editor) => {
  try {
    const doc = editor?.state?.doc;
    const size = doc?.content?.size ?? 0;
    if (!doc || size <= 0 || typeof doc.textBetween !== 'function') return '';
    return String(doc.textBetween(0, size, '\n', '\n') || '');
  } catch {
    return '';
  }
};

async function decideAllTrackedChangesForText(editor) {
  try {
    const trackChanges = editor?.doc?.trackChanges;
    if (typeof trackChanges?.decide === 'function') {
      await trackChanges.decide({ decision: 'accept', target: { scope: 'all' } });
      return;
    }
  } catch {
    // Fall through to legacy commands.
  }

  try {
    const command = editor?.commands?.acceptAllTrackedChanges;
    if (typeof command === 'function') {
      for (let i = 0; i < 3; i += 1) command.call(editor.commands);
    }
  } catch {
    // Text extraction must remain best-effort; failing to resolve revisions should not break reads.
  }
}

async function renderDocument(html) {
  const normalizedHtml = normalizeHtmlInput(html);
  const templateBuffer = await readFile(TEMPLATE_PATH);

  return await withHeadlessEditor(templateBuffer, async (editor) => {
    editor.commands.insertContent(normalizedHtml, { contentType: 'html' });
    const payload = await editor.exportDocx({ isFinalDoc: true, commentsType: 'clean' });
    return await toBuffer(payload);
  });
}

async function replaceDocumentContent(docxBuffer, html, options = {}) {
  const normalizedHtml = normalizeHtmlInput(html);
  const trackChanges = Boolean(options.trackChanges);

  return await withHeadlessEditor(docxBuffer, async (editor) => {
    if (trackChanges) editor.commands.enableTrackChanges?.();

    if (typeof editor.commands?.selectAll === 'function') {
      editor.commands.selectAll();
    } else {
      const size = editor?.state?.doc?.content?.size ?? 1;
      editor.commands?.setTextSelection?.({ from: 1, to: Math.max(1, size) });
    }

    const inserted = editor.commands?.insertContent?.(normalizedHtml, { contentType: 'html' });
    if (inserted === false) throw new Error('Failed to replace document content');

    const payload = await editor.exportDocx(
      trackChanges
        ? { isFinalDoc: false, commentsType: 'external' }
        : { isFinalDoc: true, commentsType: 'clean' },
    );
    return await toBuffer(payload);
  });
}

async function extractText(docxBuffer, options = {}) {
  return await withHeadlessEditor(docxBuffer, async (editor) => {
    if (options.final !== false) await decideAllTrackedChangesForText(editor);
    return getEditorPlainText(editor);
  });
}

const buildSearchCandidates = (findText) => {
  const raw = String(findText || '').trim();
  if (!raw) return [];
  const normalized = normalizeWhitespace(raw);
  return [...new Set([raw, normalized, normalized.replace(/ /g, '\u00a0'), raw.replace(/\u00a0/g, ' ')].filter(Boolean))];
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

async function applyHeadlessActions(editor, actions) {
  const warnings = [];
  let applied = 0;
  let units = 0;

  for (const action of actions || []) {
    const type = String(action?.type || '').trim();

    try {
      if (type === 'replace' || type === 'replaceAll' || type === 'delete') {
        const find = String(action?.find || '').trim();
        const replace = type === 'delete' ? '' : String(action?.replace ?? '');
        if (!find) {
          warnings.push(`empty find for ${type}`);
          continue;
        }

        const candidates = buildSearchCandidates(find);
        let count = 0;

        for (const candidate of candidates) {
          const matches = editor.commands?.search?.(candidate, { highlight: false }) || [];
          if (!Array.isArray(matches) || matches.length === 0) continue;

          const targets = type === 'replaceAll' ? matches : [matches[0]];
          let replacedForCandidate = 0;

          for (const target of [...targets].sort((a, b) => (b.from || 0) - (a.from || 0))) {
            if (typeof target?.from !== 'number' || typeof target?.to !== 'number') continue;
            editor.commands?.setTextSelection?.({ from: target.from, to: target.to });
            if (editor.commands?.insertContent?.(replace) !== false) replacedForCandidate += 1;
          }

          if (replacedForCandidate > 0) {
            count = replacedForCandidate;
            editor.commands?.search?.('', { highlight: false });
            break;
          }
        }

        editor.commands?.search?.('', { highlight: false });
        if (count > 0) {
          applied += 1;
          units += count;
        } else {
          warnings.push(`${type}: "${find.slice(0, 80)}" not found`);
        }
        continue;
      }

      if (type === 'insertContent') {
        const content = String(action?.content || '').trim();
        if (!content) {
          warnings.push('empty insertContent');
          continue;
        }

        if (action?.position === 'start' || action?.position === 'end') {
          const docSize = editor?.state?.doc?.content?.size ?? 1;
          const pos = action.position === 'start' ? 1 : Math.max(1, docSize);
          editor.commands?.setTextSelection?.({ from: pos, to: pos });
        }

        if (editor.commands?.insertContent?.(content, { contentType: 'html' }) !== false) {
          applied += 1;
          units += 1;
        }
        continue;
      }

      warnings.push(`unknown action: ${type || 'missing type'}`);
    } catch (error) {
      warnings.push(`action error ${type || 'unknown'}: ${error.message}`);
    }
  }

  return { applied, units, warnings };
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2));
  await rename(tempPath, filePath);
}

async function readDocumentMeta(docId) {
  return await readJsonFile(metaPath(docId), null);
}

async function writeDocumentMeta(docId, meta) {
  await writeJsonFile(metaPath(docId), meta);
}

async function documentExists(docId) {
  try {
    await access(docPath(docId));
    await access(metaPath(docId));
    return true;
  } catch {
    return false;
  }
}

async function saveRenderedDocument({ docId = randomUUID(), filename = 'ai_generated_document.docx', docxBuffer, meta = {} }) {
  await writeFile(docPath(docId), docxBuffer);

  const timestamp = nowIso();
  const documentMeta = {
    id: docId,
    filename,
    size: docxBuffer.length,
    mimetype: DOCX_MIME,
    createdAt: meta.createdAt || timestamp,
    updatedAt: timestamp,
    ...meta,
  };

  await writeDocumentMeta(docId, documentMeta);
  return documentMeta;
}

const emptyContextIndex = () => ({ version: 1, by_chat: {}, by_file: {}, by_document: {} });

const normalizeFileIds = (value) => {
  if (!value) return [];
  const rawItems = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const result = [];

  for (const item of rawItems) {
    const candidate = String(item || '').trim();
    if (!candidate || seen.has(candidate) || !FILE_ID_PATTERN.test(candidate)) continue;
    result.push(candidate);
    seen.add(candidate);
  }

  return result;
};

async function readContextIndex() {
  const raw = await readJsonFile(CONTEXT_INDEX_PATH, emptyContextIndex());
  return {
    version: 1,
    by_chat: raw?.by_chat && typeof raw.by_chat === 'object' ? raw.by_chat : {},
    by_file: raw?.by_file && typeof raw.by_file === 'object' ? raw.by_file : {},
    by_document: raw?.by_document && typeof raw.by_document === 'object' ? raw.by_document : {},
  };
}

async function writeContextIndex(index) {
  await writeJsonFile(CONTEXT_INDEX_PATH, {
    version: 1,
    by_chat: index.by_chat || {},
    by_file: index.by_file || {},
    by_document: index.by_document || {},
  });
}

async function mergeDocumentMetadata(docId, metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return await readDocumentMeta(docId);

  const meta = await readDocumentMeta(docId);
  if (!meta) throw new Error('Document not found');
  meta.metadata = { ...(meta.metadata || {}), ...metadata };
  await writeDocumentMeta(docId, meta);
  return meta;
}

async function bindDocumentContext({ documentId, chatId = '', messageId = '', fileIds = [], source = 'openwebui-tool' }) {
  const docId = safeDocId(documentId);
  if (!(await documentExists(docId))) throw new Error('Document not found');

  const normalizedChatId = String(chatId || '').trim();
  const normalizedMessageId = String(messageId || '').trim();
  const normalizedFileIds = normalizeFileIds(fileIds);
  const timestamp = nowIso();
  const meta = await readDocumentMeta(docId);
  const filename = meta?.filename || 'document.docx';
  const index = await readContextIndex();

  if (normalizedChatId) {
    const current = index.by_chat[normalizedChatId] || { documents: [] };
    const previousDocs = Array.isArray(current.documents) ? current.documents : [];
    const existing = previousDocs.find((item) => item?.document_id === docId) || {};
    const mergedFileIds = normalizeFileIds([...(existing.file_ids || []), ...normalizedFileIds]);
    const documentRef = {
      document_id: docId,
      filename,
      file_ids: mergedFileIds,
      message_id: normalizedMessageId || existing.message_id || '',
      first_seen_at: existing.first_seen_at || timestamp,
      last_seen_at: timestamp,
    };

    index.by_chat[normalizedChatId] = {
      active_document_id: docId,
      updated_at: timestamp,
      documents: [documentRef, ...previousDocs.filter((item) => item?.document_id !== docId)].slice(0, MAX_DOCUMENTS_PER_CHAT),
    };
  }

  for (const fileId of normalizedFileIds) {
    index.by_file[fileId] = {
      document_id: docId,
      chat_id: normalizedChatId,
      message_id: normalizedMessageId,
      updated_at: timestamp,
    };
  }

  const previousDocument = index.by_document[docId] || {};
  index.by_document[docId] = {
    document_id: docId,
    filename,
    chat_id: normalizedChatId || previousDocument.chat_id || '',
    message_id: normalizedMessageId || previousDocument.message_id || '',
    file_ids: normalizeFileIds([...(previousDocument.file_ids || []), ...normalizedFileIds]),
    source,
    created_at: previousDocument.created_at || timestamp,
    updated_at: timestamp,
  };

  await writeContextIndex(index);

  const contextMetadata = {
    source,
    ...(normalizedChatId ? { openwebui_chat_id: normalizedChatId } : {}),
    ...(normalizedMessageId ? { openwebui_message_id: normalizedMessageId } : {}),
    ...(normalizedFileIds[0] ? { openwebui_file_id: normalizedFileIds[0], openwebui_file_ids: normalizedFileIds } : {}),
  };
  await mergeDocumentMetadata(docId, contextMetadata);

  return {
    document_id: docId,
    chat_id: normalizedChatId,
    message_id: normalizedMessageId,
    file_ids: normalizedFileIds,
    active: Boolean(normalizedChatId),
    updated_at: timestamp,
  };
}

async function listDocumentMetas() {
  const files = await readdir(DOCUMENTS_DIR);
  const documents = [];

  for (const file of files.filter((item) => item.endsWith('.meta.json'))) {
    const meta = await readJsonFile(path.join(DOCUMENTS_DIR, file), null);
    if (meta?.id && DOC_ID_PATTERN.test(meta.id)) documents.push(meta);
  }

  documents.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  return documents;
}

async function findDocumentByMetadata({ chatId = '', fileIds = [], requireFileMatch = false }) {
  const normalizedChatId = String(chatId || '').trim();
  const normalizedFileIds = new Set(normalizeFileIds(fileIds));
  const documents = await listDocumentMetas();

  let best = null;
  let bestScore = -1;
  let bestTimestamp = '';

  for (const document of documents) {
    const metadata = document?.metadata && typeof document.metadata === 'object' ? document.metadata : {};
    const documentFileIds = new Set(normalizeFileIds(metadata.openwebui_file_ids));
    const singleFileId = String(metadata.openwebui_file_id || '').trim();
    if (FILE_ID_PATTERN.test(singleFileId)) documentFileIds.add(singleFileId);

    const fileMatched = normalizedFileIds.size > 0 && [...normalizedFileIds].some((fileId) => documentFileIds.has(fileId));
    const chatMatched = normalizedChatId && String(metadata.openwebui_chat_id || '') === normalizedChatId;

    if (requireFileMatch && !fileMatched) continue;
    if (!fileMatched && !chatMatched) continue;

    const score = fileMatched ? 3 : 1;
    const timestamp = String(document.updatedAt || document.createdAt || '');
    if (score > bestScore || (score === bestScore && timestamp > bestTimestamp)) {
      best = document;
      bestScore = score;
      bestTimestamp = timestamp;
    }
  }

  return best;
}

async function resolveDocumentContext({ documentId = '', chatId = '', fileIds = [], allowChatFallback = true }) {
  const explicit = String(documentId || '').trim();
  if (DOC_ID_PATTERN.test(explicit) && (await documentExists(explicit))) {
    return { document_id: explicit, document: await readDocumentMeta(explicit), source: 'explicit' };
  }

  const normalizedChatId = String(chatId || '').trim();
  const normalizedFileIds = normalizeFileIds(fileIds);
  const index = await readContextIndex();

  for (const fileId of normalizedFileIds) {
    const binding = index.by_file[fileId];
    const docId = binding?.document_id;
    if (docId && DOC_ID_PATTERN.test(docId) && (await documentExists(docId))) {
      return { document_id: docId, document: await readDocumentMeta(docId), source: 'file-index', binding };
    }
  }

  if (normalizedFileIds.length > 0) {
    const metadataMatch = await findDocumentByMetadata({ fileIds: normalizedFileIds, requireFileMatch: true });
    if (metadataMatch) {
      return { document_id: metadataMatch.id, document: metadataMatch, source: 'file-metadata' };
    }

    if (!allowChatFallback) {
      return { document_id: '', document: null, source: 'not-found' };
    }
  }

  if (allowChatFallback && normalizedChatId) {
    const chatBinding = index.by_chat[normalizedChatId];
    const activeDocId = chatBinding?.active_document_id;
    if (activeDocId && DOC_ID_PATTERN.test(activeDocId) && (await documentExists(activeDocId))) {
      return { document_id: activeDocId, document: await readDocumentMeta(activeDocId), source: 'chat-index', binding: chatBinding };
    }

    const documentRefs = Array.isArray(chatBinding?.documents) ? chatBinding.documents : [];
    for (const ref of documentRefs) {
      const docId = ref?.document_id;
      if (docId && DOC_ID_PATTERN.test(docId) && (await documentExists(docId))) {
        return { document_id: docId, document: await readDocumentMeta(docId), source: 'chat-history', binding: ref };
      }
    }

    const metadataMatch = await findDocumentByMetadata({ chatId: normalizedChatId });
    if (metadataMatch) {
      return { document_id: metadataMatch.id, document: metadataMatch, source: 'chat-metadata' };
    }
  }

  return { document_id: '', document: null, source: 'not-found' };
}

async function listContextDocuments(chatId, limit = 20) {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) return [];

  const index = await readContextIndex();
  const chatBinding = index.by_chat[normalizedChatId] || {};
  const refs = Array.isArray(chatBinding.documents) ? chatBinding.documents : [];
  const byId = new Map();

  for (const ref of refs) {
    const docId = ref?.document_id;
    if (!docId || !DOC_ID_PATTERN.test(docId) || !(await documentExists(docId))) continue;
    const meta = await readDocumentMeta(docId);
    byId.set(docId, { ...meta, context: ref, active: chatBinding.active_document_id === docId });
  }

  const metadataDocuments = await listDocumentMetas();
  for (const document of metadataDocuments) {
    const metadata = document?.metadata && typeof document.metadata === 'object' ? document.metadata : {};
    if (String(metadata.openwebui_chat_id || '') !== normalizedChatId) continue;
    if (!byId.has(document.id)) byId.set(document.id, { ...document, context: {}, active: false });
  }

  return [...byId.values()]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, limit);
}

async function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function sendError(res, error, fallbackStatus = 500) {
  const status = error?.code === 'ENOENT' ? 404 : fallbackStatus;
  res.status(status).json({ success: false, error: error.message || 'Unexpected error' });
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'opsup-superdoc',
    superdoc_package: '1.35.0',
    timestamp: nowIso(),
  });
});

app.post('/api/documents/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const docId = req.file.filename.replace('.docx', '');
    const requestedFilename = String(req.body?.filename || '').trim();
    const metadata = await parseMetadata(req.body?.metadata);
    const timestamp = nowIso();
    const meta = {
      id: docId,
      filename: requestedFilename || req.file.originalname,
      size: req.file.size,
      mimetype: DOCX_MIME,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };

    await writeDocumentMeta(docId, meta);

    if (metadata.openwebui_chat_id || metadata.openwebui_file_id || metadata.openwebui_file_ids) {
      await bindDocumentContext({
        documentId: docId,
        chatId: metadata.openwebui_chat_id,
        messageId: metadata.openwebui_message_id,
        fileIds: metadata.openwebui_file_ids || metadata.openwebui_file_id,
        source: metadata.source || 'openwebui-tool',
      }).catch(() => null);
    }

    res.status(201).json({ success: true, document: meta, viewerUrl: getViewerUrl(docId) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/documents', async (req, res) => {
  try {
    const limit = clampInt(req.query?.limit, 100, 1, 1000);
    const chatId = String(req.query?.chat_id || '').trim();
    const documents = chatId ? await listContextDocuments(chatId, limit) : (await listDocumentMetas()).slice(0, limit);
    res.json({ success: true, documents });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/documents/:id', async (req, res) => {
  try {
    const meta = await readDocumentMeta(req.params.id);
    if (!meta) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, document: meta, viewerUrl: getViewerUrl(req.params.id) });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.get('/api/documents/:id/text', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    await access(docPath(id));
    const meta = await readDocumentMeta(id);
    const text = await extractText(await readFile(docPath(id)));
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
      viewerUrl: getViewerUrl(id),
    });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/api/documents/:id/search-text', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ success: false, error: 'query is required' });

    await access(docPath(id));
    const maxResults = clampInt(req.body?.max_results, 20, 1, 100);
    const contextChars = clampInt(req.body?.context_chars, 200, 0, 5000);
    const text = await extractText(await readFile(docPath(id)));
    const matches = searchTextMatches(text, query, maxResults, contextChars);

    res.json({ success: true, document_id: id, total_chars: text.length, matches });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.get('/api/documents/:id/html', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    await access(docPath(id));
    res.json({ success: true, viewerUrl: getViewerUrl(id) });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    const meta = await readDocumentMeta(id);
    await access(docPath(id));
    res.download(docPath(id), meta?.filename || 'document.docx');
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    await unlink(docPath(id)).catch(() => {});
    await unlink(metaPath(id)).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/document/:id/original.docx', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    await access(docPath(id));
    res.sendFile(docPath(id), { headers: { 'Content-Type': DOCX_MIME } });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/document/:id/save', uploadInMemory.single('file'), async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Missing DOCX file payload' });

    await access(docPath(id));
    await writeFile(docPath(id), req.file.buffer);

    const meta = await readDocumentMeta(id);
    meta.size = req.file.buffer.length;
    meta.updatedAt = nowIso();
    await writeDocumentMeta(id, meta);

    res.json({ success: true, document: meta, viewerUrl: getViewerUrl(id) });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/document/:id/save-xml', express.text({ limit: '50mb' }), async (req, res) => {
  res.status(400).json({
    success: false,
    error: 'XML-only saves are disabled. Export and POST a full DOCX to /document/:id/save.',
  });
});

app.post('/api/documents/create-from-html', async (req, res) => {
  try {
    const { html, filename, metadata } = req.body || {};
    const normalizedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const docxBuffer = await renderDocument(html);
    const docId = randomUUID();
    const documentMeta = await saveRenderedDocument({
      docId,
      filename: String(filename || 'ai_generated_document.docx'),
      docxBuffer,
      meta: { ...(Object.keys(normalizedMetadata).length ? { metadata: normalizedMetadata } : {}) },
    });

    if (normalizedMetadata.openwebui_chat_id || normalizedMetadata.openwebui_file_id || normalizedMetadata.openwebui_file_ids) {
      await bindDocumentContext({
        documentId: docId,
        chatId: normalizedMetadata.openwebui_chat_id,
        messageId: normalizedMetadata.openwebui_message_id,
        fileIds: normalizedMetadata.openwebui_file_ids || normalizedMetadata.openwebui_file_id,
        source: normalizedMetadata.source || 'openwebui-tool',
      }).catch(() => null);
    }

    res.status(201).json({ success: true, document: documentMeta, viewerUrl: getViewerUrl(docId) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/documents/:id/replace-html', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    const { html, filename, metadata } = req.body || {};
    await access(docPath(id));

    const updatedBuffer = await replaceDocumentContent(await readFile(docPath(id)), html, { trackChanges: true });
    await writeFile(docPath(id), updatedBuffer);

    const meta = await readDocumentMeta(id);
    if (filename) meta.filename = String(filename);
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta.metadata = { ...(meta.metadata || {}), ...metadata };
    }
    meta.size = updatedBuffer.length;
    meta.updatedAt = nowIso();
    await writeDocumentMeta(id, meta);

    if (metadata?.openwebui_chat_id || metadata?.openwebui_file_id || metadata?.openwebui_file_ids) {
      await bindDocumentContext({
        documentId: id,
        chatId: metadata.openwebui_chat_id,
        messageId: metadata.openwebui_message_id,
        fileIds: metadata.openwebui_file_ids || metadata.openwebui_file_id,
        source: metadata.source || 'openwebui-tool',
      }).catch(() => null);
    }

    res.json({
      success: true,
      document: meta,
      viewerUrl: getViewerUrl(id),
      changes: { mode: 'html-replace' },
      text: await extractText(updatedBuffer),
    });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/api/documents/:id/apply-actions', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    const { actions, filename, metadata } = req.body || {};
    const strict = !['', '0', 'false', 'no', 'off'].includes(String(req.body?.strict ?? true).toLowerCase());

    if (!Array.isArray(actions)) return res.status(400).json({ success: false, error: 'actions must be an array' });
    if (actions.length > MAX_APPLY_ACTIONS) {
      return res.status(400).json({ success: false, error: `actions limit exceeded; max ${MAX_APPLY_ACTIONS}` });
    }

    await access(docPath(id));
    const originalBuffer = await readFile(docPath(id));

    const result = await withHeadlessEditor(originalBuffer, async (editor) => {
      editor.commands.enableTrackChanges?.();
      const changes = await applyHeadlessActions(editor, actions);
      if (changes.applied <= 0) return { ...changes, updatedBuffer: null };
      const payload = await editor.exportDocx({ isFinalDoc: false, commentsType: 'external' });
      return { ...changes, updatedBuffer: await toBuffer(payload) };
    });

    if (strict && result.applied <= 0) {
      return res.status(409).json({ success: false, error: 'No actions applied', warnings: result.warnings || [] });
    }

    const finalBuffer = result.updatedBuffer || originalBuffer;
    if (result.updatedBuffer) await writeFile(docPath(id), finalBuffer);

    const meta = await readDocumentMeta(id);
    if (filename) meta.filename = String(filename);
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta.metadata = { ...(meta.metadata || {}), ...metadata };
    }
    meta.size = finalBuffer.length;
    meta.updatedAt = nowIso();
    await writeDocumentMeta(id, meta);

    if (metadata?.openwebui_chat_id || metadata?.openwebui_file_id || metadata?.openwebui_file_ids) {
      await bindDocumentContext({
        documentId: id,
        chatId: metadata.openwebui_chat_id,
        messageId: metadata.openwebui_message_id,
        fileIds: metadata.openwebui_file_ids || metadata.openwebui_file_id,
        source: metadata.source || 'openwebui-tool',
      }).catch(() => null);
    }

    res.json({
      success: true,
      document: meta,
      viewerUrl: getViewerUrl(id),
      changes: { applied: result.applied, units: result.units, warnings: result.warnings || [] },
      text: await extractText(finalBuffer),
    });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/api/documents/create', async (req, res) => {
  try {
    const { html, htmlContent, filename, fileName, metadata } = req.body || {};
    const finalHtml = html || htmlContent;
    if (!finalHtml) {
      return res.status(400).json({
        success: false,
        error: 'Prompt-based document creation is disabled in OpsUp. The OpenWebUI model must provide final HTML.',
        hint: 'Use POST /api/documents/create-from-html or call create_document(document_html=...).',
      });
    }

    const normalizedMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const docxBuffer = await renderDocument(finalHtml);
    const docId = randomUUID();
    const documentMeta = await saveRenderedDocument({
      docId,
      filename: String(filename || fileName || 'ai_generated_document.docx'),
      docxBuffer,
      meta: { ...(Object.keys(normalizedMetadata).length ? { metadata: normalizedMetadata } : {}) },
    });

    if (normalizedMetadata.openwebui_chat_id || normalizedMetadata.openwebui_file_id || normalizedMetadata.openwebui_file_ids) {
      await bindDocumentContext({
        documentId: docId,
        chatId: normalizedMetadata.openwebui_chat_id,
        messageId: normalizedMetadata.openwebui_message_id,
        fileIds: normalizedMetadata.openwebui_file_ids || normalizedMetadata.openwebui_file_id,
        source: normalizedMetadata.source || 'openwebui-tool',
      }).catch(() => null);
    }

    res.status(201).json({ success: true, document: documentMeta, viewerUrl: getViewerUrl(docId) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/documents/:id/edit', async (req, res) => {
  try {
    const { html, document_html: documentHtml, filename, metadata } = req.body || {};
    const finalHtml = html || documentHtml;
    if (!finalHtml) {
      return res.status(400).json({
        success: false,
        error: 'Prompt-based document editing is disabled in OpsUp. The OpenWebUI model must provide final HTML or structured actions.',
        hint: 'Use POST /api/documents/:id/replace-html or /api/documents/:id/apply-actions.',
      });
    }

    const updatedBuffer = await replaceDocumentContent(await readFile(docPath(req.params.id)), finalHtml, { trackChanges: true });
    await writeFile(docPath(req.params.id), updatedBuffer);
    const meta = await readDocumentMeta(req.params.id);
    if (filename) meta.filename = String(filename);
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta.metadata = { ...(meta.metadata || {}), ...metadata };
    }
    meta.size = updatedBuffer.length;
    meta.updatedAt = nowIso();
    await writeDocumentMeta(req.params.id, meta);

    res.json({ success: true, document: meta, viewerUrl: getViewerUrl(req.params.id), changes: { mode: 'html-replace' } });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/api/documents/:id/analyze', async (req, res) => {
  try {
    const id = safeDocId(req.params.id);
    const text = await extractText(await readFile(docPath(id)));
    const query = String(req.body?.query || '').trim();
    const matches = query ? searchTextMatches(text, query, 20, 240) : [];
    res.json({ success: true, document_id: id, text, matches, note: 'Deterministic text extraction only; no internal LLM is used.' });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post('/api/context/bind', async (req, res) => {
  try {
    const result = await bindDocumentContext({
      documentId: req.body?.document_id || req.body?.documentId,
      chatId: req.body?.chat_id || req.body?.chatId,
      messageId: req.body?.message_id || req.body?.messageId,
      fileIds: req.body?.file_ids || req.body?.fileIds || req.body?.file_id || req.body?.fileId,
      source: req.body?.source || 'openwebui-tool',
    });
    res.json({ success: true, binding: result });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get('/api/context/resolve', async (req, res) => {
  try {
    const allowChatFallback = !['0', 'false', 'no', 'off'].includes(String(req.query?.allow_chat_fallback ?? 'true').toLowerCase());
    const result = await resolveDocumentContext({
      documentId: req.query?.document_id || req.query?.documentId,
      chatId: req.query?.chat_id || req.query?.chatId,
      fileIds: req.query?.file_id || req.query?.file_ids || req.query?.fileId || req.query?.fileIds,
      allowChatFallback,
    });

    res.json({
      success: Boolean(result.document_id),
      ...result,
      viewerUrl: result.document_id ? getViewerUrl(result.document_id) : '',
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get('/api/context/documents', async (req, res) => {
  try {
    const chatId = String(req.query?.chat_id || req.query?.chatId || '').trim();
    const limit = clampInt(req.query?.limit, 20, 1, 100);
    const documents = await listContextDocuments(chatId, limit);
    res.json({ success: true, chat_id: chatId, documents, count: documents.length });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpsUp SuperDoc service listening on http://0.0.0.0:${PORT}`);
  console.log(`Documents: ${DOCUMENTS_DIR}`);
  console.log('Runtime LLM calls: disabled; OpenWebUI is the only model caller');
});
