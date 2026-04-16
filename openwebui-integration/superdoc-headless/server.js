import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { JSDOM } from 'jsdom';
import { Editor } from 'superdoc/super-editor';
import multer from 'multer';

const app = express();
app.use(express.json({ limit: '2mb' }));

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const normalizeEnvProfile = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'prod' || value === 'production') return 'production';
  if (value === 'dev' || value === 'development') return 'development';
  return '';
};

const ENV_PROFILE = normalizeEnvProfile(process.env.APP_ENV || process.env.NODE_ENV);
dotenv.config({ path: path.resolve(CURRENT_DIR, '../../.env') });
if (ENV_PROFILE) {
  dotenv.config({ path: path.resolve(CURRENT_DIR, `../../.env.${ENV_PROFILE}`), override: true });
}
dotenv.config({ path: path.resolve(CURRENT_DIR, '../../.env.local'), override: true });
dotenv.config();

const PORT = Number(process.env.SUPERDOC_HEADLESS_PORT || 5004);
const LLM_BASE_URL = (process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const LLM_API_KEY = process.env.NVIDIA_API_KEY || '';
const LLM_MODEL = process.env.SUPERDOC_HEADLESS_MODEL || process.env.ANALYST_MODEL || 'openai/gpt-oss-120b';
const LLM_TIMEOUT_MS = Number(process.env.SUPERDOC_HEADLESS_TIMEOUT_MS || 120000);
const LLM_MAX_TOKENS = Number(process.env.SUPERDOC_HEADLESS_MAX_TOKENS || 5000);
const ACTIONS_SOURCE_MAX_CHARS = Number(process.env.SUPERDOC_HEADLESS_ACTIONS_SOURCE_MAX_CHARS || 45000);
const HEADLESS_EDIT_MAX_ACTIONS = Number(process.env.SUPERDOC_HEADLESS_EDIT_MAX_ACTIONS || 12);
const HEADLESS_EDIT_MAX_FILE_MB = Number(process.env.SUPERDOC_HEADLESS_EDIT_MAX_FILE_MB || 20);
const HEADLESS_MIN_RETENTION_RATIO = Number(process.env.SUPERDOC_HEADLESS_MIN_RETENTION_RATIO || 0.45);
const HEADLESS_METRICS_WINDOW_MS = Number(process.env.SUPERDOC_HEADLESS_METRICS_WINDOW_MS || 300000);
const DEFAULT_TEMPLATE_PATH = path.join(
  CURRENT_DIR,
  'templates',
  'blank.docx'
);
const TEMPLATE_DOCX_PATH =
  process.env.SUPERDOC_HEADLESS_TEMPLATE_PATH || DEFAULT_TEMPLATE_PATH;
const HEADLESS_EDITOR_USER_NAME =
  (process.env.SUPERDOC_HEADLESS_USER_NAME || 'AI Assistant').trim() || 'AI Assistant';
const HEADLESS_EDITOR_USER_EMAIL =
  (process.env.SUPERDOC_HEADLESS_USER_EMAIL || 'ai-assistant@local').trim() || 'ai-assistant@local';
const HEADLESS_EDITOR_USER_IMAGE =
  (process.env.SUPERDOC_HEADLESS_USER_IMAGE || '').trim();

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const makeRequestId = () =>
  `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const getHeadlessEditorUser = () => ({
  name: HEADLESS_EDITOR_USER_NAME,
  email: HEADLESS_EDITOR_USER_EMAIL,
  image: HEADLESS_EDITOR_USER_IMAGE,
});

const ERROR_CODE_REGISTRY = Object.freeze({
  UNSUPPORTED_STYLE_INTENT: {
    category: 'validation',
    support_hint: 'Форматирование (цвет/шрифт/размер) примените вручную в редакторе.',
  },
  DESTRUCTIVE_PLAN_NOT_APPLIED: {
    category: 'safety',
    support_hint: 'Уточните, какие разделы нужно удалить или оставить.',
  },
  RETENTION_RATIO_TOO_LOW: {
    category: 'safety',
    support_hint: 'Разбейте задачу на несколько точечных правок.',
  },
  EMPTY_PLAN: {
    category: 'planning',
    support_hint: 'Сформулируйте конкретное изменение и укажите целевой фрагмент текста.',
  },
  NO_ACTIONS_APPLIED: {
    category: 'planning',
    support_hint: 'Уточните формулировку: что именно заменить и на что.',
  },
  TEXT_NOT_CHANGED: {
    category: 'planning',
    support_hint: 'Проверьте формулировку и укажите точный участок текста.',
  },
  INTERNAL_ERROR: {
    category: 'internal',
    support_hint: 'Повторите запрос позже или передайте request_id в поддержку.',
  },
});

const logJson = (event, payload = {}) => {
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      service: 'superdoc-headless',
      event,
      ...payload,
    }));
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[superdoc-headless] ${event}`);
  }
};

const nowMs = () => Date.now();

const HEADLESS_METRICS = {
  edit_submitted_total: 0,
  edit_success_total: 0,
  edit_validation_error_total: 0,
  edit_internal_error_total: 0,
  validation_error_total_by_code: {},
  planner_empty_plan_total: 0,
  planner_retry_total: 0,
  planner_single_action_repair_total: 0,
  planner_actions_generated_total: 0,
  planner_actions_applied_total: 0,
  events: [],
  latencies_ms: [],
};

const percentile = (values, p) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, idx));
  return sorted[clamped];
};

const pruneHeadlessMetrics = () => {
  const threshold = nowMs() - HEADLESS_METRICS_WINDOW_MS;
  HEADLESS_METRICS.events = HEADLESS_METRICS.events.filter((entry) => entry.ts >= threshold);
  HEADLESS_METRICS.latencies_ms = HEADLESS_METRICS.latencies_ms.filter((entry) => entry.ts >= threshold);
};

const bumpValidationCodeCounter = (code) => {
  if (!code) return;
  const normalized = String(code).split(':', 1)[0].trim().toUpperCase();
  if (!normalized) return;
  HEADLESS_METRICS.validation_error_total_by_code[normalized] =
    Number(HEADLESS_METRICS.validation_error_total_by_code[normalized] || 0) + 1;
  if (normalized === 'EMPTY_PLAN') {
    HEADLESS_METRICS.planner_empty_plan_total += 1;
  }
};

const recordHeadlessEvent = ({ outcome, latencyMs = 0, validationCode = '' }) => {
  const ts = nowMs();
  HEADLESS_METRICS.events.push({
    ts,
    outcome: String(outcome || 'unknown'),
    validation_code: validationCode || '',
  });
  if (Number(latencyMs) > 0) {
    HEADLESS_METRICS.latencies_ms.push({
      ts,
      value: Number(latencyMs),
    });
  }
  pruneHeadlessMetrics();
};

const getHeadlessMetricsSnapshot = () => {
  pruneHeadlessMetrics();
  const events = HEADLESS_METRICS.events;
  const total5m = events.length;
  const errorEvents5m = events.filter((entry) =>
    entry.outcome === 'validation_error' || entry.outcome === 'internal_error').length;
  const emptyPlanEvents5m = events.filter((entry) => entry.validation_code === 'EMPTY_PLAN').length;
  const latencyValues = HEADLESS_METRICS.latencies_ms.map((entry) => entry.value);
  const p95 = percentile(latencyValues, 95);
  const p50 = percentile(latencyValues, 50);
  return {
    totals: {
      edit_submitted_total: HEADLESS_METRICS.edit_submitted_total,
      edit_success_total: HEADLESS_METRICS.edit_success_total,
      edit_validation_error_total: HEADLESS_METRICS.edit_validation_error_total,
      edit_internal_error_total: HEADLESS_METRICS.edit_internal_error_total,
      planner_empty_plan_total: HEADLESS_METRICS.planner_empty_plan_total,
      planner_retry_total: HEADLESS_METRICS.planner_retry_total,
      planner_single_action_repair_total: HEADLESS_METRICS.planner_single_action_repair_total,
      planner_actions_generated_total: HEADLESS_METRICS.planner_actions_generated_total,
      planner_actions_applied_total: HEADLESS_METRICS.planner_actions_applied_total,
      validation_error_total_by_code: HEADLESS_METRICS.validation_error_total_by_code,
    },
    window_5m: {
      requests_total: total5m,
      error_rate_5m: total5m > 0 ? Number((errorEvents5m / total5m).toFixed(4)) : 0,
      empty_plan_rate_5m: total5m > 0 ? Number((emptyPlanEvents5m / total5m).toFixed(4)) : 0,
      p50_latency_ms: Math.round(p50),
      p95_latency_ms: Math.round(p95),
    },
  };
};

const normalizeValidationCode = (value) =>
  String(value || '').split(':', 1)[0].trim().toUpperCase();

const getErrorDescriptor = (code) => {
  const normalized = normalizeValidationCode(code);
  if (normalized && ERROR_CODE_REGISTRY[normalized]) {
    return { code: normalized, ...ERROR_CODE_REGISTRY[normalized] };
  }
  return {
    code: normalized || 'INTERNAL_ERROR',
    ...ERROR_CODE_REGISTRY.INTERNAL_ERROR,
  };
};

const buildControlledErrorPayload = (error, requestId = '') => {
  const descriptor = getErrorDescriptor(error?.errorCode || error?.validationErrors?.[0] || '');
  const validationErrors = Array.isArray(error?.validationErrors) ? error.validationErrors : [];
  const warnings = Array.isArray(error?.warnings)
    ? error.warnings.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    success: false,
    error: error?.message || 'Ошибка валидации',
    error_code: descriptor.code,
    error_category: error?.errorCategory || descriptor.category,
    support_hint: error?.supportHint || descriptor.support_hint,
    validation_errors: validationErrors,
    warnings,
    retention_ratio:
      typeof error?.retentionRatio === 'number' ? error.retentionRatio : null,
    request_id: requestId || null,
  };
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: HEADLESS_EDIT_MAX_FILE_MB * 1024 * 1024,
  },
});

function createHeadlessDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    DOMParser: globalThis.DOMParser,
    XMLSerializer: globalThis.XMLSerializer,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
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
      globalThis.window = previousGlobals.window;
      globalThis.document = previousGlobals.document;
      globalThis.DOMParser = previousGlobals.DOMParser;
      globalThis.XMLSerializer = previousGlobals.XMLSerializer;
      globalThis.Node = previousGlobals.Node;
      globalThis.HTMLElement = previousGlobals.HTMLElement;
      dom.window.close();
    },
  };
}

function sanitizeTitle(rawTitle) {
  const MAX_TITLE_LEN = 96;
  const fallback = `Новый документ ${new Date().toISOString().slice(0, 10)}`;
  let cleaned = String(rawTitle || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > MAX_TITLE_LEN) {
    cleaned = cleaned.slice(0, MAX_TITLE_LEN).trim();
  }
  return cleaned || fallback;
}

function ensureDocxExt(name) {
  return name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
}

const toBuffer = async (docxBuffer) => {
  if (Buffer.isBuffer(docxBuffer)) {
    return docxBuffer;
  }
  if (docxBuffer instanceof Uint8Array) {
    return Buffer.from(docxBuffer);
  }
  if (docxBuffer && typeof docxBuffer.arrayBuffer === 'function') {
    const ab = await docxBuffer.arrayBuffer();
    return Buffer.from(ab);
  }
  if (
    docxBuffer &&
    typeof docxBuffer === 'object' &&
    docxBuffer.type === 'Buffer' &&
    Array.isArray(docxBuffer.data)
  ) {
    return Buffer.from(docxBuffer.data);
  }
  throw new Error('exportDocx returned unsupported payload type');
};

const encodeMetaHeader = (value) =>
  encodeURIComponent(
    typeof value === 'string' ? value : JSON.stringify(value ?? '')
  );

const decodeMetaHeader = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(String(value)));
  } catch {
    return decodeURIComponent(String(value));
  }
};

const normalizeWhitespace = (value) =>
  String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

class ControlledValidationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlledValidationError';
    this.validationErrors = Array.isArray(options.validationErrors)
      ? options.validationErrors
      : [];
    const firstCode = normalizeValidationCode(
      options.errorCode || this.validationErrors[0] || ''
    );
    const descriptor = getErrorDescriptor(firstCode);
    this.errorCode = descriptor.code;
    this.errorCategory = options.errorCategory || descriptor.category;
    this.supportHint = options.supportHint || descriptor.support_hint;
    this.retentionRatio =
      typeof options.retentionRatio === 'number' ? options.retentionRatio : null;
    this.statusCode = Number(options.statusCode || 400);
    this.warnings = Array.isArray(options.warnings)
      ? options.warnings.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  }
}

const tokenizeForRetention = (text) => {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
};

const computeRetentionRatio = (beforeText, afterText) => {
  const beforeTokens = tokenizeForRetention(beforeText);
  const afterTokens = tokenizeForRetention(afterText);
  if (beforeTokens.length === 0) return 1;

  const beforeMap = new Map();
  for (const token of beforeTokens) {
    beforeMap.set(token, (beforeMap.get(token) || 0) + 1);
  }

  let common = 0;
  for (const token of afterTokens) {
    const count = beforeMap.get(token) || 0;
    if (count > 0) {
      common += 1;
      beforeMap.set(token, count - 1);
    }
  }

  return common / beforeTokens.length;
};

const isStyleIntent = (prompt) => {
  const text = String(prompt || '').toLowerCase();
  const styleHints = [
    'шрифт',
    'кегл',
    'размер',
    'размер шрифта',
    'цвет',
    'цветом',
    'arial',
    'times new roman',
    'cambria',
    'calibri',
    'жирн',
    'курсив',
    'подчерки',
    'полужир',
    'font',
    'color',
    'bold',
    'italic',
    'underline',
  ];
  if (styleHints.some((hint) => text.includes(hint))) {
    return true;
  }
  const tokens = (text.match(/\p{L}+/gu) || []).map((item) => String(item || '').trim()).filter(Boolean);
  const ruColorWords = new Set([
    'красный', 'красная', 'красное', 'красные', 'красного', 'красному', 'красным', 'красными', 'красную', 'красной', 'красных',
    'синий', 'синяя', 'синее', 'синие', 'синего', 'синему', 'синим', 'синими', 'синюю', 'синей', 'синих',
    'зеленый', 'зелёный', 'зеленая', 'зелёная', 'зеленое', 'зелёное', 'зеленые', 'зелёные',
    'зеленого', 'зелёного', 'зеленому', 'зелёному', 'зеленым', 'зелёным', 'зелеными', 'зелёными',
    'зеленую', 'зелёную', 'зеленой', 'зелёной', 'зеленых', 'зелёных',
    'голубой', 'голубая', 'голубое', 'голубые', 'голубого', 'голубому', 'голубым', 'голубыми', 'голубую', 'голубой', 'голубых',
    'черный', 'чёрный', 'черная', 'чёрная', 'черное', 'чёрное', 'черные', 'чёрные', 'черным', 'чёрным',
    'белый', 'белая', 'белое', 'белые', 'белым',
  ]);
  const enColorWords = new Set(['red', 'blue', 'green', 'black', 'white']);
  const hasColorWord = tokens.some((token) => ruColorWords.has(token) || enColorWords.has(token));
  const hasStyleContext =
    text.includes('цвет') ||
    text.includes('шрифт') ||
    text.includes('текст') ||
    text.includes('букв') ||
    /\b(?:font|color|text)\b/.test(text);
  if (hasStyleContext && hasColorWord) {
    return true;
  }
  return /\b\d+\s*(pt|пт)\b/.test(text);
};

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

const buildSearchCandidates = (findText) => {
  const raw = String(findText || '').trim();
  if (!raw) return [];
  const normalized = normalizeWhitespace(raw);
  const nbspVariant = normalized.replace(/ /g, '\u00a0');
  const compactVariant = raw.replace(/\u00a0/g, ' ');
  const candidates = [raw, normalized, nbspVariant, compactVariant];
  return [...new Set(candidates.filter(Boolean))];
};

const getSelectionPosition = (editor, position) => {
  const docSize = editor?.state?.doc?.content?.size ?? 1;
  if (position === 'start') {
    return 1;
  }
  return Math.max(1, docSize);
};

const normalizeDocumentMode = (mode) => {
  const normalized = String(mode || '').trim().toLowerCase();
  return normalized === 'suggesting' ? 'suggesting' : 'editing';
};

const applyReplaceAction = (editor, findText, replaceText, replaceAll = false) => {
  if (!findText || typeof findText !== 'string') return { count: 0, candidate: '' };

  const candidates = buildSearchCandidates(findText);
  for (const candidate of candidates) {
    const matches = editor?.commands?.search?.(candidate, { highlight: false }) || [];
    if (!Array.isArray(matches) || matches.length === 0) continue;

    const targets = replaceAll ? matches : [matches[0]];
    const orderedTargets = [...targets].sort((a, b) => (b.from || 0) - (a.from || 0));
    let replacedCount = 0;

    for (const target of orderedTargets) {
      if (typeof target?.from !== 'number' || typeof target?.to !== 'number') continue;
      const selected = editor?.commands?.setTextSelection?.({ from: target.from, to: target.to });
      if (selected === false) continue;
      const inserted = editor?.commands?.insertContent?.(replaceText || '');
      if (inserted !== false) {
        replacedCount += 1;
      }
    }
    editor?.commands?.search?.('', { highlight: false });
    if (replacedCount > 0) {
      return { count: replacedCount, candidate };
    }
  }

  return { count: 0, candidate: '' };
};

const applyInsertContentAction = (editor, action) => {
  const content = String(action?.content || '').trim();
  if (!content) return 0;

  const positionRaw = String(action?.position || 'cursor').trim().toLowerCase();
  const position = ['start', 'end', 'cursor'].includes(positionRaw) ? positionRaw : 'cursor';
  if (position === 'start' || position === 'end') {
    const pos = getSelectionPosition(editor, position);
    editor?.commands?.setTextSelection?.({ from: pos, to: pos });
  }

  const inserted = editor?.commands?.insertContent?.(content, { contentType: 'html' });
  return inserted === false ? 0 : 1;
};

const applyHeadlessActions = async (editor, actions, options = {}) => {
  const warnings = [];
  let actionsApplied = 0;
  let operationUnitsApplied = 0;
  const documentMode = normalizeDocumentMode(options.documentMode);
  const trackChangesEnabled = documentMode === 'suggesting';

  if (trackChangesEnabled && editor?.commands?.enableTrackChanges) {
    editor.commands.enableTrackChanges();
  } else if (!trackChangesEnabled && editor?.commands?.disableTrackChanges) {
    editor.commands.disableTrackChanges();
  }

  for (const action of actions || []) {
    const type = String(action?.type || '').trim();
    try {
      if (type === 'replace') {
        const replaced = applyReplaceAction(
          editor,
          String(action?.find || ''),
          String(action?.replace || ''),
          false
        );
        if (replaced.count > 0) {
          actionsApplied += 1;
          operationUnitsApplied += replaced.count;
        } else {
          warnings.push(`replace: "${String(action?.find || '').slice(0, 80)}" не найден`);
        }
        continue;
      }

      if (type === 'replaceAll') {
        const replaced = applyReplaceAction(
          editor,
          String(action?.find || ''),
          String(action?.replace || ''),
          true
        );
        if (replaced.count > 0) {
          actionsApplied += 1;
          operationUnitsApplied += replaced.count;
        } else {
          warnings.push(`replaceAll: "${String(action?.find || '').slice(0, 80)}" не найден`);
        }
        continue;
      }

      if (type === 'insertContent') {
        const inserted = applyInsertContentAction(editor, action);
        if (inserted > 0) {
          actionsApplied += 1;
          operationUnitsApplied += inserted;
        } else {
          warnings.push('insertContent: пустой content');
        }
        continue;
      }

      warnings.push(`Неподдерживаемое действие: ${type || 'unknown'}`);
    } catch (error) {
      warnings.push(`Ошибка действия ${type || 'unknown'}: ${error?.message || 'unknown error'}`);
    }
  }

  return { actionsApplied, operationUnitsApplied, warnings, trackChangesEnabled };
};

const isDestructiveIntent = (prompt) => {
  const text = String(prompt || '').toLowerCase();
  const destructiveHints = [
    'сократи документ',
    'сократи максимально',
    'сократи текст',
    'сократить документ',
    'сократить максимально',
    'оставь 1-2 строки',
    'оставить 1-2 строки',
    'оставь 1-2',
    'оставить 1-2',
    'сильно сократи',
    'максимально сократи',
    'перепиши полностью',
    'переписать полностью',
    'удали всё',
    'удалить всё',
    'удали весь текст',
    'удалить весь текст',
    'замени весь документ',
    'rewrite completely',
    'replace entire document',
    'delete all',
  ];
  return destructiveHints.some((hint) => text.includes(hint));
};

async function callLlmForHtml(prompt) {
  if (!LLM_API_KEY) {
    throw new Error('SUPERDOC headless: NVIDIA_API_KEY is not configured');
  }

  const systemPrompt = [
    'Ты создаешь контент для DOCX документа.',
    'Верни ТОЛЬКО валидный HTML без markdown и без пояснений.',
    'Используй только семантические теги: h1, h2, h3, p, ul, ol, li, table, thead, tbody, tr, th, td.',
    'Если данных не хватает, добавляй реалистичные тестовые данные.',
    'Текст обязательно на русском языке, если запрос на русском.',
    'Не используй кодовые блоки, префиксы и служебный текст.',
  ].join(' ');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.25,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM API ${response.status}: ${text.slice(0, 500)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('LLM API returned empty content');
    }
    return content.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

function stripMarkdownFences(content) {
  const fenced = content.match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return content;
}

function stripJsonMarkdownFences(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return content;
}

function parseJsonObject(content) {
  const cleaned = stripJsonMarkdownFences(String(content || '').trim());
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match?.[0]) {
      return JSON.parse(match[0]);
    }
    throw new Error('Не удалось распарсить JSON план действий');
  }
}

function normalizeActionPlan(plan, maxActions) {
  const actionsInput = Array.isArray(plan?.actions) ? plan.actions : [];
  const actions = [];
  const warnings = [];

  for (const raw of actionsInput) {
    if (actions.length >= maxActions) break;
    const type = String(raw?.type || '').trim();
    if (!type) continue;

    if (type === 'replace' || type === 'replaceAll') {
      const find = String(raw?.find || '').trim();
      const replace = String(raw?.replace || '');
      if (!find) {
        warnings.push(`Пропущено ${type}: пустое поле find`);
        continue;
      }
      actions.push({ type, find, replace });
      continue;
    }

    if (type === 'insertContent') {
      const content = String(raw?.content || '').trim();
      const positionRaw = String(raw?.position || 'cursor').trim().toLowerCase();
      const position = ['start', 'end', 'cursor'].includes(positionRaw) ? positionRaw : 'cursor';
      if (!content) {
        warnings.push('Пропущено insertContent: пустое поле content');
        continue;
      }
      actions.push({ type, content, position });
      continue;
    }

    warnings.push(`Неподдерживаемый тип действия: ${type}`);
  }

  return {
    summary: String(plan?.summary || '').trim(),
    actions,
    warnings,
  };
}

async function callLlmForActionPlan({
  prompt,
  documentText,
  selection = '',
  maxActions = 8,
  isEmptyDocument = false,
  requestId = '',
}) {
  if (!LLM_API_KEY) {
    throw new Error('SUPERDOC headless: NVIDIA_API_KEY is not configured');
  }
  if (isStyleIntent(prompt)) {
    throw new ControlledValidationError(
      'Запрос касается форматирования (цвет/шрифт/размер), но текущий AI-режим применяет только текстовые правки.',
      {
        validationErrors: ['UNSUPPORTED_STYLE_INTENT'],
        errorCode: 'UNSUPPORTED_STYLE_INTENT',
      }
    );
  }

  const clippedDocumentText = String(documentText || '').slice(0, ACTIONS_SOURCE_MAX_CHARS);
  const clippedSelection = String(selection || '').slice(0, 5000);
  const safeMaxActions = Math.min(Math.max(Number(maxActions) || 8, 1), 20);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  const requestPlanAttempt = async ({
    systemPrompt,
    userPrompt,
    temperature,
    maxTokens,
  }) => {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM API ${response.status}: ${text.slice(0, 500)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      return {
        summary: '',
        actions: [],
        warnings: ['LLM вернула пустой ответ для плана действий'],
      };
    }

    try {
      const parsed = parseJsonObject(content);
      return normalizeActionPlan(parsed, safeMaxActions);
    } catch (error) {
      return {
        summary: '',
        actions: [],
        warnings: [`Ошибка парсинга плана действий: ${error?.message || 'unknown'}`],
      };
    }
  };

  const buildSingleActionRepair = () => {
    const patterns = [
      /(?:замени|измени|поменяй)\s+["«“]?(.+?)["»”]?\s+(?:на|в)\s+["«“]?(.+?)["»”]?$/i,
      /(?:replace|change)\s+["']?(.+?)["']?\s+(?:to|with)\s+["']?(.+?)["']?$/i,
    ];
    const rawPrompt = String(prompt || '').trim();
    for (const pattern of patterns) {
      const match = rawPrompt.match(pattern);
      if (!match) continue;
      const find = String(match[1] || '').trim();
      const replace = String(match[2] || '').trim();
      if (!find) continue;
      const candidates = buildSearchCandidates(find);
      const found = candidates.some((candidate) => String(documentText || '').includes(candidate));
      if (!found) continue;
      let occurrences = 0;
      for (const candidate of candidates) {
        if (!candidate) continue;
        const count = String(documentText || '').split(candidate).length - 1;
        occurrences = Math.max(occurrences, count);
      }
      return {
        summary: 'Применен deterministic fallback для точечной замены.',
        actions: [
          {
            type: occurrences > 1 ? 'replaceAll' : 'replace',
            find,
            replace,
          },
        ],
        warnings: ['Использован fallback single-action repair после пустого плана LLM.'],
      };
    }
    return null;
  };

  try {
    const primarySystemPrompt = [
      'Ты AI-помощник для редактирования DOCX через SuperDoc.',
      'Верни ТОЛЬКО JSON без пояснений.',
      `Разрешены только действия: replace, replaceAll, insertContent. Максимум действий: ${safeMaxActions}.`,
      'Правила выбора действий:',
      '1) replace: одна точечная замена первой найденной подстроки.',
      '2) replaceAll: массовая замена всех повторений подстроки.',
      '3) insertContent: добавление нового HTML-контента (position: start|end|cursor).',
      'Для replace/replaceAll поле find должно быть точным фрагментом из текста документа.',
      'Если документ пустой, нужно использовать insertContent с полноценным содержанием.',
      'Формат ответа строго:',
      '{"summary":"...","actions":[{"type":"replace","find":"...","replace":"..."},{"type":"replaceAll","find":"...","replace":"..."},{"type":"insertContent","position":"end","content":"<p>...</p>"}]}',
    ].join(' ');

    const primaryUserPrompt = [
      `request_id: ${requestId || 'n/a'}`,
      `Запрос пользователя:\n${prompt}`,
      `\nДокумент пустой: ${isEmptyDocument ? 'да' : 'нет'}`,
      clippedSelection ? `\nВыделенный фрагмент:\n${clippedSelection}` : '',
      `\nТекст документа:\n${clippedDocumentText}`,
    ].join('\n');

    const primary = await requestPlanAttempt({
      systemPrompt: primarySystemPrompt,
      userPrompt: primaryUserPrompt,
      temperature: 0.1,
      maxTokens: Math.min(LLM_MAX_TOKENS, 3000),
    });
    HEADLESS_METRICS.planner_actions_generated_total += Number(primary.actions?.length || 0);

    if (Array.isArray(primary.actions) && primary.actions.length > 0) {
      return {
        summary: primary.summary || 'План редактирования сформирован',
        actions: primary.actions,
        warnings: primary.warnings || [],
        clipped_document: clippedDocumentText.length < String(documentText || '').length,
        plan_source: 'llm_primary',
      };
    }

    if (isDestructiveIntent(prompt)) {
      throw new ControlledValidationError(
        'Запрос на сильное сокращение или переписывание документа отклонен по правилам безопасности.',
        {
          validationErrors: ['DESTRUCTIVE_PLAN_NOT_APPLIED'],
          errorCode: 'DESTRUCTIVE_PLAN_NOT_APPLIED',
        }
      );
    }

    HEADLESS_METRICS.planner_retry_total += 1;
    const retrySystemPrompt = [
      'Верни ТОЛЬКО JSON.',
      'Сделай максимально короткий план: 1-2 действия.',
      'Разрешены только replace, replaceAll, insertContent.',
      'Если не уверен в массовой замене, выбирай replace.',
      '{"summary":"...","actions":[{"type":"replace","find":"точный фрагмент","replace":"новый текст"}]}',
    ].join(' ');
    const retryUserPrompt = [
      `request_id: ${requestId || 'n/a'}`,
      `Запрос: ${prompt}`,
      `Документ пустой: ${isEmptyDocument ? 'да' : 'нет'}`,
      `Текст документа:\n${clippedDocumentText.slice(0, Math.min(clippedDocumentText.length, 18000))}`,
    ].join('\n');
    const retry = await requestPlanAttempt({
      systemPrompt: retrySystemPrompt,
      userPrompt: retryUserPrompt,
      temperature: 0,
      maxTokens: Math.min(LLM_MAX_TOKENS, 1200),
    });
    HEADLESS_METRICS.planner_actions_generated_total += Number(retry.actions?.length || 0);
    if (Array.isArray(retry.actions) && retry.actions.length > 0) {
      return {
        summary: retry.summary || 'План редактирования сформирован (retry)',
        actions: retry.actions,
        warnings: [...(primary.warnings || []), ...(retry.warnings || []), 'План получен после retry.'],
        clipped_document: clippedDocumentText.length < String(documentText || '').length,
        plan_source: 'llm_retry',
      };
    }

    const repaired = buildSingleActionRepair();
    if (repaired) {
      HEADLESS_METRICS.planner_single_action_repair_total += 1;
      HEADLESS_METRICS.planner_actions_generated_total += Number(repaired.actions?.length || 0);
      return {
        summary: repaired.summary,
        actions: repaired.actions,
        warnings: [
          ...(primary.warnings || []),
          ...(retry.warnings || []),
          ...(repaired.warnings || []),
        ],
        clipped_document: clippedDocumentText.length < String(documentText || '').length,
        plan_source: 'single_action_repair',
      };
    }

    throw new ControlledValidationError(
      'AI не смог сформировать валидный план правок для этого запроса.',
      {
        validationErrors: ['EMPTY_PLAN'],
        errorCode: 'EMPTY_PLAN',
      }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function renderDocxFromHtml(html) {
  const domEnv = createHeadlessDom();
  const templateBuffer = await readFile(TEMPLATE_DOCX_PATH);
  const editor = await Editor.open(templateBuffer, {
    isHeadless: true,
    document: domEnv.document,
    suppressDefaultDocxStyles: true,
    user: getHeadlessEditorUser(),
  });
  try {
    editor.commands.insertContent(html, { contentType: 'html' });
    const docxBuffer = await editor.exportDocx({
      isFinalDoc: true,
      commentsType: 'clean',
    });
    return await toBuffer(docxBuffer);
  } finally {
    editor.destroy();
    domEnv.restore();
  }
}

async function withHeadlessEditorFromDocx(docxBuffer, fn, options = {}) {
  const domEnv = createHeadlessDom();
  let editor = null;
  try {
    editor = await Editor.open(docxBuffer, {
      isHeadless: true,
      document: domEnv.document,
      suppressDefaultDocxStyles: options.suppressDefaultDocxStyles ?? true,
      user: getHeadlessEditorUser(),
    });
    return await fn(editor);
  } finally {
    if (editor) {
      editor.destroy();
    }
    domEnv.restore();
  }
}

async function buildActionPlanV2({
  prompt,
  documentText,
  selection = '',
  maxActions = HEADLESS_EDIT_MAX_ACTIONS,
  isEmptyDocument = false,
  requestId = '',
}) {
  const safeMaxActions = Math.min(Math.max(Number(maxActions) || 8, 1), 20);
  const plan = await callLlmForActionPlan({
    prompt,
    documentText,
    selection,
    maxActions: safeMaxActions,
    isEmptyDocument,
    requestId,
  });

  const destructive_intent = isDestructiveIntent(prompt);
  const actions = plan.actions || [];
  const warnings = [...(plan.warnings || [])];

  if (!destructive_intent && actions.length > safeMaxActions) {
    warnings.push(`План был усечен до ${safeMaxActions} действий`);
  }

  return {
    success: true,
    summary: plan.summary || 'План редактирования сформирован',
    actions,
    actions_planned: actions.length,
    warnings,
    destructive_intent,
    clipped_document: Boolean(plan.clipped_document),
    plan_source: plan.plan_source || 'llm_primary',
  };
}

async function applyActionsToDocxBuffer({
  docxBuffer,
  actions,
  requestId = '',
  documentMode = 'editing',
  destructiveIntent = false,
  prompt = '',
}) {
  if (!Buffer.isBuffer(docxBuffer) || docxBuffer.length === 0) {
    throw new Error('Пустой DOCX payload');
  }
  const normalizedDocumentMode = normalizeDocumentMode(documentMode);
  const normalizedActions = Array.isArray(actions) ? actions : [];
  if (normalizedActions.length === 0) {
    throw new ControlledValidationError(
      'Не удалось сформировать план правок для этого запроса. Уточните, что именно нужно изменить.',
      {
        validationErrors: ['EMPTY_PLAN'],
      }
    );
  }

  const startedAt = Date.now();
  const result = await withHeadlessEditorFromDocx(
    docxBuffer,
    async (editor) => {
      const textBefore = getEditorPlainText(editor);
      const beforeNormalized = normalizeWhitespace(textBefore);
      const applyStartedAt = Date.now();
      const applied = await applyHeadlessActions(editor, normalizedActions, {
        documentMode: normalizedDocumentMode,
      });
      const tApplyExecMs = Date.now() - applyStartedAt;
      const textAfter = getEditorPlainText(editor);
      const afterNormalized = normalizeWhitespace(textAfter);
      const textChanged = beforeNormalized !== afterNormalized;
      const retentionRatio = computeRetentionRatio(beforeNormalized, afterNormalized);

      if (applied.actionsApplied <= 0) {
        if (destructiveIntent) {
          throw new ControlledValidationError(
            'Запрос на сильное сокращение/переписывание не удалось безопасно применить.',
            {
              validationErrors: ['DESTRUCTIVE_PLAN_NOT_APPLIED'],
            }
          );
        }
        throw new ControlledValidationError(
          'AI не смог безопасно применить правки к документу.',
          {
            validationErrors: ['NO_ACTIONS_APPLIED'],
          }
        );
      }
      if (!textChanged) {
        if (isStyleIntent(prompt)) {
          throw new ControlledValidationError(
            'Запрос касается форматирования, но текущий action-план поддерживает только текстовые операции.',
            {
              validationErrors: ['UNSUPPORTED_STYLE_INTENT'],
              retentionRatio,
            }
          );
        }
        throw new ControlledValidationError(
          'Изменения не применились к документу.',
          {
            validationErrors: ['TEXT_NOT_CHANGED'],
            retentionRatio,
          }
        );
      }

      if (!destructiveIntent && retentionRatio < HEADLESS_MIN_RETENTION_RATIO) {
        throw new ControlledValidationError(
          'Изменения выглядят разрушительными или неполными. Уточните запрос.',
          {
            validationErrors: [
              `RETENTION_RATIO_TOO_LOW:${retentionRatio.toFixed(3)}<${HEADLESS_MIN_RETENTION_RATIO}`,
            ],
            retentionRatio,
          }
        );
      }

      if (normalizedDocumentMode === 'editing' && editor?.commands?.acceptAllTrackedChanges) {
        editor.commands.acceptAllTrackedChanges();
      }

      const exportStartedAt = Date.now();
      const exported = await editor.exportDocx({
        isFinalDoc: true,
        commentsType: 'clean',
      });
      const edited = await toBuffer(exported);
      const tExportMs = Date.now() - exportStartedAt;

      return {
        edited,
        warnings: applied.warnings || [],
        actionsApplied: applied.actionsApplied,
        operationUnitsApplied: applied.operationUnitsApplied,
        trackChangesEnabled: applied.trackChangesEnabled,
        retentionRatio,
        tApplyExecMs,
        tExportMs,
      };
    },
    { suppressDefaultDocxStyles: true }
  );

  const latencyMs = Date.now() - startedAt;
  HEADLESS_METRICS.planner_actions_applied_total += Number(result.actionsApplied || 0);
  return {
    success: true,
    request_id: requestId || null,
    document_mode: normalizedDocumentMode,
    actions_applied: result.actionsApplied,
    operation_units_applied: result.operationUnitsApplied,
    track_changes_enabled: Boolean(result.trackChangesEnabled),
    warnings: result.warnings || [],
    validation_errors: [],
    retention_ratio: result.retentionRatio,
    latency_ms: latencyMs,
    latency_breakdown_ms: {
      t_apply_exec: result.tApplyExecMs || 0,
      t_export: result.tExportMs || 0,
      t_apply_total: latencyMs,
    },
    edited_docx: result.edited,
  };
}

async function renderEmptyDocx() {
  const domEnv = createHeadlessDom();
  let editor = null;
  try {
    const templateBuffer = await readFile(TEMPLATE_DOCX_PATH);
    editor = await Editor.open(templateBuffer, {
      isHeadless: true,
      document: domEnv.document,
      suppressDefaultDocxStyles: true,
      user: getHeadlessEditorUser(),
    });

    const docxBuffer = await editor.exportDocx({
      isFinalDoc: true,
      commentsType: 'clean',
    });
    return await toBuffer(docxBuffer);
  } finally {
    if (editor) {
      editor.destroy();
    }
    domEnv.restore();
  }
}

app.get('/health', async (_req, res) => {
  try {
    const domEnv = createHeadlessDom();
    const templateBuffer = await readFile(TEMPLATE_DOCX_PATH);
    try {
      const editor = await Editor.open(templateBuffer, {
        isHeadless: true,
        document: domEnv.document,
        suppressDefaultDocxStyles: true,
        user: getHeadlessEditorUser(),
      });
      editor.destroy();
    } finally {
      domEnv.restore();
    }
    const metrics = getHeadlessMetricsSnapshot();
    res.json({
      status: 'ok',
      service: 'superdoc-headless',
      llm_model: LLM_MODEL,
      template_path: TEMPLATE_DOCX_PATH,
      headless_ready: true,
      pipeline_mode: 'headless',
      max_actions: HEADLESS_EDIT_MAX_ACTIONS,
      min_retention_ratio: HEADLESS_MIN_RETENTION_RATIO,
      error_rate_5m: metrics.window_5m.error_rate_5m,
      empty_plan_rate_5m: metrics.window_5m.empty_plan_rate_5m,
      p95_latency_ms: metrics.window_5m.p95_latency_ms,
      metrics_window_ms: HEADLESS_METRICS_WINDOW_MS,
      metrics: metrics.totals,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      service: 'superdoc-headless',
      headless_ready: false,
      pipeline_mode: 'headless',
      error: error?.message || String(error),
      warnings: [],
    });
  }
});

app.post('/api/create-docx', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const requestedFilename = String(req.body?.filename || '').trim();

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required', warnings: [] });
    }

    const htmlRaw = await callLlmForHtml(prompt);
    const html = stripMarkdownFences(htmlRaw);
    if (!html) {
      return res
        .status(500)
        .json({ success: false, error: 'LLM returned empty html content', warnings: [] });
    }

    const docxBuffer = await renderDocxFromHtml(html);
    const title = sanitizeTitle(requestedFilename || prompt);
    const filename = ensureDocxExt(title);

    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('x-generated-filename', encodeURIComponent(filename));
    res.setHeader('x-generated-html-length', String(html.length));
    res.setHeader('Content-Length', String(docxBuffer.length));
    return res.status(200).end(docxBuffer);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      warnings: [],
    });
  }
});

app.post('/api/create-empty-docx', async (req, res) => {
  try {
    const requestedFilename = String(req.body?.filename || '').trim();
    const title = sanitizeTitle(requestedFilename || 'Новый документ');
    const filename = ensureDocxExt(title);

    const docxBuffer = await renderEmptyDocx();
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('x-generated-filename', encodeURIComponent(filename));
    res.setHeader('Content-Length', String(docxBuffer.length));
    return res.status(200).end(docxBuffer);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      warnings: [],
    });
  }
});

app.post('/api/plan-actions-v2', async (req, res) => {
  const requestId = String(req.body?.request_id || '').trim() || makeRequestId();
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const documentTextRaw = String(req.body?.document_text || '');
    const isEmptyDocument = !documentTextRaw.trim();
    const documentText = isEmptyDocument ? '(Пустой документ)' : documentTextRaw;
    const selection = String(req.body?.selection || '');
    const maxActions = Number(req.body?.max_actions || HEADLESS_EDIT_MAX_ACTIONS);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required', warnings: [] });
    }

    const plan = await buildActionPlanV2({
      prompt,
      documentText,
      selection,
      maxActions,
      isEmptyDocument,
      requestId,
    });
    logJson('planner_quality', {
      request_id: requestId,
      stage: 'plan',
      empty_plan: Number(plan.actions_planned || 0) === 0,
      actions_generated: Number(plan.actions_planned || 0),
      plan_source: plan.plan_source || 'unknown',
      destructive_intent: Boolean(plan.destructive_intent),
    });

    return res.json({
      success: true,
      request_id: requestId || null,
      contract_version: 'headless-v1',
      ...plan,
    });
  } catch (error) {
    if (error instanceof ControlledValidationError) {
      const payload = buildControlledErrorPayload(error, requestId);
      bumpValidationCodeCounter(payload.error_code);
      return res.status(error.statusCode || 400).json(payload);
    }
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      error_code: 'INTERNAL_ERROR',
      error_category: ERROR_CODE_REGISTRY.INTERNAL_ERROR.category,
      support_hint: ERROR_CODE_REGISTRY.INTERNAL_ERROR.support_hint,
      warnings: [],
      request_id: requestId || null,
    });
  }
});

// Backward-compatible alias for existing callers
app.post('/api/plan-actions', async (req, res) => {
  const requestId = String(req.body?.request_id || '').trim() || makeRequestId();
  try {
    const documentTextRaw = String(req.body?.document_text || '');
    const isEmptyDocument = !documentTextRaw.trim();
    const payload = {
      prompt: String(req.body?.prompt || '').trim(),
      documentText: isEmptyDocument ? '(Пустой документ)' : documentTextRaw,
      selection: String(req.body?.selection || ''),
      maxActions: Number(req.body?.max_actions || HEADLESS_EDIT_MAX_ACTIONS),
      isEmptyDocument,
      requestId,
    };
    if (!payload.prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required', warnings: [] });
    }
    const plan = await buildActionPlanV2(payload);
    return res.json({
      success: true,
      summary: plan.summary,
      actions: plan.actions,
      warnings: plan.warnings,
      clipped_document: plan.clipped_document,
      destructive_intent: plan.destructive_intent,
      plan_source: plan.plan_source,
      request_id: requestId || null,
    });
  } catch (error) {
    if (error instanceof ControlledValidationError) {
      const payload = buildControlledErrorPayload(error, requestId);
      bumpValidationCodeCounter(payload.error_code);
      return res.status(error.statusCode || 400).json(payload);
    }
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      error_code: 'INTERNAL_ERROR',
      error_category: ERROR_CODE_REGISTRY.INTERNAL_ERROR.category,
      support_hint: ERROR_CODE_REGISTRY.INTERNAL_ERROR.support_hint,
      warnings: [],
      request_id: requestId || null,
    });
  }
});

app.post('/api/apply-actions-headless', upload.single('file'), async (req, res) => {
  const requestId = String(req.body?.request_id || '').trim() || makeRequestId();
  try {
    const file = req.file;
    const documentMode = normalizeDocumentMode(
      String(req.body?.document_mode || 'editing').trim()
    );
    const prompt = String(req.body?.prompt || '').trim();
    const destructiveIntent =
      String(req.body?.destructive_intent || '').toLowerCase() === 'true';
    const actionsRaw = req.body?.actions;
    const stageStartedAt = Date.now();

    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'file is required', warnings: [] });
    }
    if (!actionsRaw) {
      return res.status(400).json({ success: false, error: 'actions is required', warnings: [] });
    }

    let actions;
    try {
      actions = JSON.parse(String(actionsRaw));
    } catch {
      return res.status(400).json({ success: false, error: 'actions must be valid JSON', warnings: [] });
    }

    const applyResult = await applyActionsToDocxBuffer({
      docxBuffer: Buffer.from(file.buffer),
      actions,
      requestId,
      documentMode,
      prompt,
      destructiveIntent,
    });
    const totalMs = Date.now() - stageStartedAt;

    const warnings = applyResult.warnings || [];
    logJson('apply_actions_headless_ok', {
      request_id: requestId,
      document_mode: documentMode,
      actions_requested: Array.isArray(actions) ? actions.length : 0,
      actions_applied: applyResult.actions_applied || 0,
      track_changes_enabled: Boolean(applyResult.track_changes_enabled),
      latency_ms: totalMs,
      latency_breakdown_ms: applyResult.latency_breakdown_ms || {},
      warnings_count: warnings.length,
    });
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('x-contract-version', 'headless-v1');
    res.setHeader('x-request-id', encodeMetaHeader(requestId || ''));
    res.setHeader('x-actions-applied', String(applyResult.actions_applied || 0));
    res.setHeader('x-operation-units-applied', String(applyResult.operation_units_applied || 0));
    res.setHeader('x-latency-ms', String(applyResult.latency_ms || 0));
    res.setHeader('x-latency-breakdown-ms', encodeMetaHeader(applyResult.latency_breakdown_ms || {}));
    res.setHeader('x-warnings', encodeMetaHeader(warnings));
    res.setHeader('x-validation-errors', encodeMetaHeader(applyResult.validation_errors || []));
    res.setHeader(
      'x-retention-ratio',
      String(
        typeof applyResult.retention_ratio === 'number'
          ? applyResult.retention_ratio
          : ''
      )
    );
    res.setHeader('x-document-mode', encodeMetaHeader(documentMode));
    res.setHeader('x-track-changes-enabled', String(Boolean(applyResult.track_changes_enabled)));
    res.setHeader('Content-Length', String(applyResult.edited_docx.length));
    return res.status(200).end(applyResult.edited_docx);
  } catch (error) {
    if (error instanceof ControlledValidationError) {
      const payload = buildControlledErrorPayload(error, requestId);
      bumpValidationCodeCounter(payload.error_code);
      logJson('apply_actions_headless_validation_error', {
        error: error.message,
        validation_errors: error.validationErrors || [],
        warnings: error.warnings || [],
        retention_ratio: error.retentionRatio,
        request_id: requestId,
        error_code: payload.error_code,
      });
      return res.status(error.statusCode || 400).json(payload);
    }
    logJson('apply_actions_headless_error', {
      error: error?.message || String(error),
      request_id: requestId,
    });
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      error_code: 'INTERNAL_ERROR',
      error_category: ERROR_CODE_REGISTRY.INTERNAL_ERROR.category,
      support_hint: ERROR_CODE_REGISTRY.INTERNAL_ERROR.support_hint,
      warnings: [],
      request_id: requestId || null,
    });
  }
});

app.post('/api/edit-docx-headless', upload.single('file'), async (req, res) => {
  const requestId = String(req.body?.request_id || '').trim() || makeRequestId();
  const routeStartedAt = Date.now();
  HEADLESS_METRICS.edit_submitted_total += 1;
  try {
    const file = req.file;
    const prompt = String(req.body?.prompt || '').trim();
    const selection = String(req.body?.selection || '');
    const documentMode = normalizeDocumentMode(
      String(req.body?.document_mode || 'editing').trim()
    );
    const maxActions = Number(req.body?.max_actions || HEADLESS_EDIT_MAX_ACTIONS);

    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'file is required', warnings: [] });
    }
    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required', warnings: [] });
    }

    const sourceDocx = Buffer.from(file.buffer);
    const startedAt = Date.now();
    logJson('edit_docx_headless_start', {
      request_id: requestId,
      document_mode: documentMode,
      prompt_len: prompt.length,
      max_actions: maxActions,
      source_docx_bytes: sourceDocx.length,
    });

    const extractStartedAt = Date.now();
    const documentTextRaw = await withHeadlessEditorFromDocx(
      sourceDocx,
      async (editor) => getEditorPlainText(editor),
      { suppressDefaultDocxStyles: true }
    );
    const tExtractTextMs = Date.now() - extractStartedAt;
    const isEmptyDocument = !documentTextRaw.trim();
    const documentText = isEmptyDocument ? '(Пустой документ)' : documentTextRaw;

    const planStartedAt = Date.now();
    const plan = await buildActionPlanV2({
      prompt,
      documentText,
      selection,
      maxActions,
      isEmptyDocument,
      requestId,
    });
    logJson('planner_quality', {
      request_id: requestId,
      stage: 'plan',
      empty_plan: Number(plan.actions_planned || 0) === 0,
      actions_generated: Number(plan.actions_planned || 0),
      plan_source: plan.plan_source || 'unknown',
      destructive_intent: Boolean(plan.destructive_intent),
    });
    const tLlmPlanMs = Date.now() - planStartedAt;
    if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'План правок пустой. Уточните, какие части документа нужно изменить.',
        warnings: [],
      });
    }

    const applyResult = await applyActionsToDocxBuffer({
      docxBuffer: sourceDocx,
      actions: plan.actions,
      requestId,
      documentMode,
      destructiveIntent: Boolean(plan.destructive_intent),
      prompt,
    });

    const totalLatencyMs = Date.now() - startedAt;
    const warnings = [...(plan.warnings || []), ...(applyResult.warnings || [])];
    if (isEmptyDocument) {
      warnings.push('Планирование выполнено для пустого документа (insertContent-first)');
    }
    const finalBreakdown = {
      t_extract_text: tExtractTextMs,
      t_llm_plan: tLlmPlanMs,
      ...(applyResult.latency_breakdown_ms || {}),
      t_total: totalLatencyMs,
    };
    logJson('edit_docx_headless_ok', {
      request_id: requestId,
      document_mode: documentMode,
      is_empty_document: isEmptyDocument,
      actions_planned: plan.actions_planned || plan.actions.length || 0,
      actions_applied: applyResult.actions_applied || 0,
      track_changes_enabled: Boolean(applyResult.track_changes_enabled),
      warnings_count: warnings.length,
      latency_ms: totalLatencyMs,
      latency_breakdown_ms: finalBreakdown,
    });
    logJson('planner_quality', {
      request_id: requestId,
      stage: 'apply',
      empty_plan: false,
      actions_generated: Number(plan.actions_planned || 0),
      actions_applied: Number(applyResult.actions_applied || 0),
      plan_source: plan.plan_source || 'unknown',
    });
    HEADLESS_METRICS.edit_success_total += 1;
    recordHeadlessEvent({ outcome: 'success', latencyMs: totalLatencyMs, validationCode: '' });

    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('x-contract-version', 'headless-v1');
    res.setHeader('x-request-id', encodeMetaHeader(requestId || ''));
    res.setHeader('x-summary', encodeMetaHeader(plan.summary || 'Изменения применены'));
    res.setHeader('x-actions-planned', String(plan.actions_planned || plan.actions.length || 0));
    res.setHeader('x-actions-applied', String(applyResult.actions_applied || 0));
    res.setHeader('x-operation-units-applied', String(applyResult.operation_units_applied || 0));
    res.setHeader('x-warnings', encodeMetaHeader(warnings));
    res.setHeader('x-document-mode', encodeMetaHeader(documentMode));
    res.setHeader('x-track-changes-enabled', String(Boolean(applyResult.track_changes_enabled)));
    res.setHeader('x-destructive-intent', String(Boolean(plan.destructive_intent)));
    res.setHeader('x-plan-source', encodeMetaHeader(plan.plan_source || 'llm_primary'));
    res.setHeader(
      'x-validation-errors',
      encodeMetaHeader(applyResult.validation_errors || [])
    );
    res.setHeader(
      'x-retention-ratio',
      String(
        typeof applyResult.retention_ratio === 'number'
          ? applyResult.retention_ratio
          : ''
      )
    );
    res.setHeader(
      'x-latency-breakdown-ms',
      encodeMetaHeader(finalBreakdown)
    );
    res.setHeader('x-latency-ms', String(totalLatencyMs));
    res.setHeader('Content-Length', String(applyResult.edited_docx.length));
    return res.status(200).end(applyResult.edited_docx);
  } catch (error) {
    if (error instanceof ControlledValidationError) {
      const payload = buildControlledErrorPayload(error, requestId);
      HEADLESS_METRICS.edit_validation_error_total += 1;
      bumpValidationCodeCounter(payload.error_code);
      recordHeadlessEvent({
        outcome: 'validation_error',
        latencyMs: Date.now() - routeStartedAt,
        validationCode: payload.error_code || '',
      });
      logJson('edit_docx_headless_validation_error', {
        error: error.message,
        validation_errors: error.validationErrors || [],
        warnings: error.warnings || [],
        retention_ratio: error.retentionRatio,
        request_id: requestId,
        error_code: payload.error_code,
      });
      return res.status(error.statusCode || 400).json(payload);
    }
    HEADLESS_METRICS.edit_internal_error_total += 1;
    recordHeadlessEvent({
      outcome: 'internal_error',
      latencyMs: Date.now() - routeStartedAt,
      validationCode: '',
    });
    logJson('edit_docx_headless_error', {
      error: error?.message || String(error),
      request_id: requestId,
    });
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      error_code: 'INTERNAL_ERROR',
      error_category: ERROR_CODE_REGISTRY.INTERNAL_ERROR.category,
      support_hint: ERROR_CODE_REGISTRY.INTERNAL_ERROR.support_hint,
      warnings: [],
      request_id: requestId || null,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`SuperDoc headless service started on port ${PORT}`);
});
