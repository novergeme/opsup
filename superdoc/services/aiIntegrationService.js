const OpenAI = require('openai');
const DocumentService = require('./documentService');
const logger = require('../utils/logger');

class AIIntegrationService {
  constructor() {
    this.client = null;
    this.initializeClient();
  }

  // Initialize OpenAI client
  initializeClient() {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseURL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';

    if (apiKey) {
      this.client = new OpenAI({
        apiKey: apiKey,
        baseURL: baseURL
      });
      logger.info(`OpenAI client initialized: ${baseURL}`);
    } else {
      logger.error('No OPENAI_API_KEY provided');
    }
  }

  // Get model name - use provided or default
  getModel(model) {
    return model || process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b';
  }

  // Edit document with AI
  async editDocument(docId, prompt, model = null, options = {}) {
    const docService = new DocumentService(process.env.DOCUMENT_STORAGE_PATH);
    const htmlContent = await docService.getDocumentHTML(docId);
    
    const modelName = this.getModel(model);
    logger.info(`Editing document ${docId} with model: ${modelName}`);

    try {
      const response = await this.client.chat.completions.create({
        model: modelName,
        messages: [
          {
            role: 'system',
            content: 'You are a professional document editor. Edit the following HTML document according to the user\'s instructions. Return ONLY the edited HTML content in a complete HTML document, no explanations.'
          },
          {
            role: 'user',
            content: `Original document:\n\n${htmlContent}\n\nEdit instructions: ${prompt}`
          }
        ],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 4000
      });

      const editedContent = response.choices[0].message.content;

      // Update document
      const metadata = await docService.updateDocument(docId, editedContent, {
        changelog: `AI edited with prompt: ${prompt.substring(0, 50)}...`
      });

      return {
        document: metadata,
        changes: {
          original: htmlContent,
          edited: editedContent,
          prompt
        }
      };
    } catch (error) {
      logger.error('Edit error:', error);
      throw new Error(`AI editing failed: ${error.message}`);
    }
  }

  // Create new document from prompt
  async createDocument(prompt, template = null, model = null, metadata = {}) {
    const docService = new DocumentService(process.env.DOCUMENT_STORAGE_PATH);
    const modelName = this.getModel(model);
    
    logger.info(`Creating document with model: ${modelName}`);

    // Build system prompt based on template
    const systemPrompt = this.getSystemPromptForTemplate(template);

    try {
      const response = await this.client.chat.completions.create({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4000
      });

      const htmlContent = response.choices[0].message.content;

      // Create document
      const docId = await docService.createDocumentFromHTML(htmlContent, {
        filename: `ai_generated_${template || 'document'}.docx`,
        metadata: {
          template,
          prompt,
          model: modelName,
          ...metadata
        }
      });

      return await docService.getDocument(docId);
    } catch (error) {
      logger.error('Create error:', error);
      throw new Error(`Document creation failed: ${error.message}`);
    }
  }

  // Analyze document with AI
  async analyzeDocument(docId, query = null, model = null) {
    const docService = new DocumentService(process.env.DOCUMENT_STORAGE_PATH);
    const htmlContent = await docService.getDocumentHTML(docId);
    const modelName = this.getModel(model);

    try {
      const response = await this.client.chat.completions.create({
        model: modelName,
        messages: [
          {
            role: 'system',
            content: 'You are a professional document analyst. Provide a comprehensive analysis of the following document.'
          },
          {
            role: 'user',
            content: `Analyze this document and provide:\n1. Summary\n2. Key points\n3. Structure overview\n4. Suggestions for improvement\n\nDocument:\n\n${htmlContent}`
          }
        ],
        max_tokens: 4000
      });

      return {
        summary: response.choices[0].message.content,
        type: 'general'
      };
    } catch (error) {
      logger.error('Analysis error:', error);
      throw new Error(`Document analysis failed: ${error.message}`);
    }
  }

  // Get system prompt for template
  getSystemPromptForTemplate(template) {
    const templates = {
      'car-sale': `You are a vehicle sales contract generator. Create a comprehensive car sale contract in HTML format. Include: buyer/seller information, vehicle details (make, model, year, VIN, mileage), sale price, payment terms, warranties, signatures. Return ONLY valid HTML with inline CSS styling.`,
      
      contract: `You are a legal document generator. Create professional, legally sound contracts in HTML format. Use proper legal language and structure. Include all necessary sections: parties, terms, conditions, signatures, etc. Return ONLY valid HTML with inline CSS styling.`,
      
      agreement: `You are a business agreement generator. Create professional agreements in HTML format. Include: parties, effective date, terms, obligations, termination conditions, signatures. Return ONLY valid HTML with inline CSS styling.`,
      
      report: `You are a report generator. Create structured, professional reports in HTML format. Include: title, executive summary, sections, conclusions, recommendations. Return ONLY valid HTML with inline CSS styling.`,
      
      default: `You are a professional document generator. Create well-structured documents in HTML format with proper styling. Return ONLY valid HTML content, no markdown or explanations. Use inline CSS for styling.`
    };

    return templates[template] || templates.default;
  }
}

module.exports = AIIntegrationService;
