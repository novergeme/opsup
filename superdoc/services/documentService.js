const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const logger = require('../utils/logger');

class DocumentService {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.documentsPath = path.join(storagePath, 'documents');
    this.uploadsPath = path.join(storagePath, 'uploads');
    
    // Initialize directories
    this.init();
  }

  async init() {
    await fs.mkdir(this.documentsPath, { recursive: true });
    await fs.mkdir(this.uploadsPath, { recursive: true });
  }

  // Process uploaded file
  async processUpload(file) {
    const docId = uuidv4();
    const docPath = path.join(this.documentsPath, docId);
    
    await fs.mkdir(docPath, { recursive: true });

    // Move file to document directory
    const originalPath = file.path;
    const newPath = path.join(docPath, 'original.docx');
    await fs.rename(originalPath, newPath);

    // Generate HTML preview
    const html = await this.convertToHTML(newPath);
    await fs.writeFile(path.join(docPath, 'preview.html'), html);

    // Extract text for RAG
    const text = await this.extractText(newPath);
    await fs.writeFile(path.join(docPath, 'content.txt'), text);

    // Save metadata
    const metadata = {
      id: docId,
      filename: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(docPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    return metadata;
  }

  // Get document metadata
  async getDocument(docId) {
    const metadataPath = path.join(this.documentsPath, docId, 'metadata.json');
    const metadata = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(metadata);
  }

  // List all documents
  async listDocuments() {
    const documents = [];
    const entries = await fs.readdir(this.documentsPath);

    for (const entry of entries) {
      try {
        const metadata = await this.getDocument(entry);
        documents.push(metadata);
      } catch (error) {
        logger.warn(`Skipping invalid document directory: ${entry}`);
      }
    }

    return documents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // Get document HTML preview
  async getDocumentHTML(docId) {
    const previewPath = path.join(this.documentsPath, docId, 'preview.html');
    const html = await fs.readFile(previewPath, 'utf-8');
    return html;
  }

  // Get document file path
  async getDocumentFile(docId) {
    const filePath = path.join(this.documentsPath, docId, 'original.docx');
    await fs.access(filePath);
    return filePath;
  }

  // Convert DOCX to HTML
  async convertToHTML(filePath) {
    const result = await mammoth.convertToHtml({ path: filePath }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        const imageBuffer = await image.read();
        const base64 = imageBuffer.toString('base64');
        return {
          src: `data:${image.contentType};base64,${base64}`
        };
      })
    });
    
    if (result.messages.length > 0) {
      logger.debug('Mammoth conversion messages:', result.messages);
    }

    return this.wrapHTML(result.value);
  }

  // Wrap HTML in viewer template
  wrapHTML(content) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Viewer</title>
  <link rel="stylesheet" href="/viewer/styles.css">
</head>
<body class="docviewer">
  <div class="document-container">
    ${content}
  </div>
  <script src="/viewer/editor.js"></script>
</body>
</html>
    `.trim();
  }

  // Extract text from DOCX
  async extractText(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  // Update document with new content
  async updateDocument(docId, htmlContent, options = {}) {
    const docPath = path.join(this.documentsPath, docId);
    
    // Update HTML preview
    await fs.writeFile(path.join(docPath, 'preview.html'), this.wrapHTML(htmlContent));

    // Convert HTML back to DOCX
    const docxBuffer = await this.convertHTMLToDOCX(htmlContent);
    await fs.writeFile(path.join(docPath, 'updated.docx'), docxBuffer);

    // Update metadata
    const metadata = await this.getDocument(docId);
    metadata.updatedAt = new Date().toISOString();
    if (options.changelog) {
      metadata.changelog = metadata.changelog || [];
      metadata.changelog.push({
        timestamp: new Date().toISOString(),
        description: options.changelog
      });
    }
    await fs.writeFile(
      path.join(docPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    return metadata;
  }

  // Convert HTML to DOCX (simplified version)
  async convertHTMLToDOCX(htmlContent) {
    // This is a simplified implementation
    // In production, you'd use a more sophisticated converter
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            children: [
              new TextRun('Document content generated/edited by AI')
            ]
          })
        ]
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    return buffer;
  }

  // Export document to different format
  async exportDocument(docId, format) {
    const docPath = path.join(this.documentsPath, docId);
    const sourceFile = path.join(docPath, 'updated.docx');
    
    // Check if updated version exists, otherwise use original
    try {
      await fs.access(sourceFile);
    } catch {
      sourceFile = path.join(docPath, 'original.docx');
    }

    const exportPath = path.join(docPath, `export.${format}`);
    
    // For now, just copy the DOCX file
    // In production, you'd implement actual format conversion
    await fs.copyFile(sourceFile, exportPath);
    
    return exportPath;
  }

  // Delete document
  async deleteDocument(docId) {
    const docPath = path.join(this.documentsPath, docId);
    await fs.rm(docPath, { recursive: true, force: true });
  }

  // Create document from HTML content
  async createDocumentFromHTML(htmlContent, options = {}) {
    const docId = uuidv4();
    const docPath = path.join(this.documentsPath, docId);
    
    await fs.mkdir(docPath, { recursive: true });

    // Save HTML preview
    await fs.writeFile(path.join(docPath, 'preview.html'), this.wrapHTML(htmlContent));

    // Convert HTML to DOCX (simplified)
    const docxBuffer = await this.convertHTMLToDOCX(htmlContent);
    await fs.writeFile(path.join(docPath, 'original.docx'), docxBuffer);

    // Extract text for RAG
    const text = await this.extractText(path.join(docPath, 'original.docx'));
    await fs.writeFile(path.join(docPath, 'content.txt'), text);

    // Save metadata
    const metadata = {
      id: docId,
      filename: options.filename || 'ai_generated.docx',
      size: docxBuffer.length,
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...options.metadata
    };
    await fs.writeFile(
      path.join(docPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    return docId;
  }
}

module.exports = DocumentService;
