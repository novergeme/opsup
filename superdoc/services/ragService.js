const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class RAGService {
  constructor() {
    this.chromaDBUrl = process.env.CHROMA_DB_URL || 'http://chromadb:8000';
    this.embeddingModel = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-ada-002';
    this.collectionName = 'documents';
  }

  // Initialize RAG pipeline
  async initialize() {
    try {
      // Create collection if it doesn't exist
      await this.createCollection();
      logger.info('RAG service initialized');
    } catch (error) {
      logger.error('Failed to initialize RAG service:', error);
    }
  }

  // Create ChromaDB collection
  async createCollection() {
    const response = await fetch(`${this.chromaDBUrl}/api/v1/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.collectionName })
    });

    if (!response.ok && response.status !== 409) {
      throw new Error(`Failed to create collection: ${response.statusText}`);
    }

    return response.json();
  }

  // Index document for RAG
  async indexDocument(docId, textContent, metadata = {}) {
    try {
      // Split text into chunks
      const chunks = this.chunkText(textContent, 1000, 200);

      // Generate embeddings for each chunk
      const embeddings = await this.generateEmbeddings(chunks);

      // Store in ChromaDB
      await this.storeEmbeddings(docId, chunks, embeddings, metadata);

      logger.info(`Document ${docId} indexed for RAG with ${chunks.length} chunks`);
    } catch (error) {
      logger.error(`Failed to index document ${docId}:`, error);
      throw error;
    }
  }

  // Query document with RAG
  async queryDocument(docId, query) {
    try {
      // Generate embedding for query
      const queryEmbedding = await this.generateEmbedding(query);

      // Search for similar chunks
      const results = await this.searchSimilar(docId, queryEmbedding, 5);

      // Return context
      return results.map(r => r.text).join('\n\n');
    } catch (error) {
      logger.error(`Failed to query document ${docId}:`, error);
      throw error;
    }
  }

  // Text chunking
  chunkText(text, chunkSize, overlap) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - overlap;
    }

    return chunks;
  }

  // Generate embedding (OpenAI API)
  async generateEmbedding(text) {
    const response = await fetch(`${process.env.OPENAI_API_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        input: text,
        model: this.embeddingModel
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding generation failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  // Generate embeddings for multiple texts
  async generateEmbeddings(texts) {
    const embeddings = [];

    for (const text of texts) {
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);
    }

    return embeddings;
  }

  // Store embeddings in ChromaDB
  async storeEmbeddings(docId, texts, embeddings, metadata) {
    const ids = texts.map((_, i) => `${docId}_chunk_${i}`);
    const metadatas = texts.map((text, i) => ({
      docId,
      chunkIndex: i,
      textLength: text.length,
      ...metadata
    }));

    const response = await fetch(`${this.chromaDBUrl}/api/v1/collections/${this.collectionName}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids,
        embeddings,
        metadatas,
        documents: texts
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to store embeddings: ${response.statusText}`);
    }

    return response.json();
  }

  // Search for similar chunks
  async searchSimilar(docId, queryEmbedding, nResults = 5) {
    const response = await fetch(`${this.chromaDBUrl}/api/v1/collections/${this.collectionName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [queryEmbedding],
        n_results: nResults,
        where: { docId }
      })
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    return data.documents[0].map((doc, i) => ({
      text: doc,
      metadata: data.metadatas[0][i],
      distance: data.distances[0][i]
    }));
  }

  // Delete document embeddings
  async deleteDocument(docId) {
    const response = await fetch(`${this.chromaDBUrl}/api/v1/collections/${this.collectionName}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where: { docId }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to delete document embeddings: ${response.statusText}`);
    }

    logger.info(`Deleted embeddings for document ${docId}`);
  }
}

module.exports = RAGService;
