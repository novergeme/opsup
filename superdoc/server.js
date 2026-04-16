const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const DocumentService = require('./services/documentService');
const AIIntegrationService = require('./services/aiIntegrationService');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 8081;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files for SuperDoc viewer
app.use('/viewer', express.static(path.join(__dirname, 'viewer')));

// Document storage
const DOCUMENT_STORAGE_PATH = process.env.DOCUMENT_STORAGE_PATH || path.join(__dirname, '../documents');
const UPLOAD_MAX_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB

// Ensure storage directory exists
(async () => {
  await fs.mkdir(DOCUMENT_STORAGE_PATH, { recursive: true });
})();

// Configure multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(DOCUMENT_STORAGE_PATH, 'uploads');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.docx', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .docx and .doc files are allowed'));
    }
  }
});

// Initialize services
const docService = new DocumentService(DOCUMENT_STORAGE_PATH);
const aiService = new AIIntegrationService();

// ============================================
// API Routes
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Upload document
app.post('/api/documents/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const document = await docService.processUpload(req.file);
    logger.info(`Document uploaded: ${document.id}`);
    
    res.status(201).json({
      success: true,
      document,
      viewerUrl: `/viewer/index.html?docId=${document.id}`
    });
  } catch (error) {
    logger.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get document list
app.get('/api/documents', async (req, res) => {
  try {
    const documents = await docService.listDocuments();
    res.json({ success: true, documents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get document by ID
app.get('/api/documents/:id', async (req, res) => {
  try {
    const document = await docService.getDocument(req.params.id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ success: true, document });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get document HTML for viewer
app.get('/api/documents/:id/html', async (req, res) => {
  try {
    const html = await docService.getDocumentHTML(req.params.id);
    res.json({ success: true, html });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download document
app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const filePath = await docService.getDocumentFile(req.params.id);
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit document with AI
app.post('/api/documents/:id/edit', async (req, res) => {
  try {
    const { prompt, model, options } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Use specified model or default
    const aiModel = model || process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b';
    
    const result = await aiService.editDocument(req.params.id, prompt, aiModel, options);
    logger.info(`Document edited with AI: ${req.params.id} using model: ${aiModel}`);
    
    res.json({
      success: true,
      document: result.document,
      changes: result.changes,
      viewerUrl: `/viewer/index.html?docId=${result.document.id}`
    });
  } catch (error) {
    logger.error('Edit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new document from prompt
app.post('/api/documents/create', async (req, res) => {
  try {
    const { prompt, template, model, metadata } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Use specified model or default
    const aiModel = model || process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b';
    
    const document = await aiService.createDocument(prompt, template, aiModel, metadata);
    logger.info(`Document created with AI using model: ${aiModel}`);
    
    res.status(201).json({
      success: true,
      document,
      viewerUrl: `/viewer/index.html?docId=${document.id}`
    });
  } catch (error) {
    logger.error('Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analyze document
app.post('/api/documents/:id/analyze', async (req, res) => {
  try {
    const { query, model } = req.body;
    
    const aiModel = model || process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b';
    
    const analysis = await aiService.analyzeDocument(req.params.id, query, aiModel);
    
    res.json({
      success: true,
      analysis
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export document to different format
app.post('/api/documents/:id/export', async (req, res) => {
  try {
    const { format } = req.body;
    const filePath = await docService.exportDocument(req.params.id, format);
    
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete document
app.delete('/api/documents/:id', async (req, res) => {
  try {
    await docService.deleteDocument(req.params.id);
    res.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`SuperDoc server running on port ${PORT}`);
  logger.info(`Document storage: ${DOCUMENT_STORAGE_PATH}`);
});

module.exports = app;
