// SuperDoc Viewer & Editor JavaScript

class SuperDocViewer {
  constructor() {
    this.docId = null;
    this.zoom = 100;
    this.isEditMode = false;
    this.apiBase = window.location.origin;
    
    this.init();
  }

  async init() {
    // Get document ID from URL
    const params = new URLSearchParams(window.location.search);
    this.docId = params.get('docId');

    if (!this.docId) {
      this.showError('No document ID provided');
      return;
    }

    // Load document
    await this.loadDocument();

    // Setup event listeners
    this.setupEventListeners();

    // Update UI
    this.updateUI();
  }

  async loadDocument() {
    try {
      const response = await fetch(`${this.apiBase}/api/documents/${this.docId}/html`);
      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to load document');
      }

      const container = document.getElementById('document-container');
      container.innerHTML = data.html;

      // Update document info
      const docResponse = await fetch(`${this.apiBase}/api/documents/${this.docId}`);
      const docData = await docResponse.json();
      
      if (docData.success) {
        document.getElementById('document-title').textContent = docData.document.filename;
        document.getElementById('doc-info').textContent = 
          `Last modified: ${new Date(docData.document.updatedAt).toLocaleString()}`;
      }

    } catch (error) {
      this.showError(error.message);
    }
  }

  setupEventListeners() {
    // Edit button
    document.getElementById('btn-edit')?.addEventListener('click', () => this.toggleEditMode());

    // Download button
    document.getElementById('btn-download')?.addEventListener('click', () => this.downloadDocument());

    // Zoom controls
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.zoomOut());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (this.isEditMode) {
          this.saveDocument();
        }
      }

      // Ctrl/Cmd + E to toggle edit mode
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        this.toggleEditMode();
      }
    });
  }

  toggleEditMode() {
    this.isEditMode = !this.isEditMode;
    const container = document.getElementById('document-container');
    const btnEdit = document.getElementById('btn-edit');

    if (this.isEditMode) {
      container.contentEditable = 'true';
      container.classList.add('edit-mode');
      btnEdit.textContent = 'Save';
      btnEdit.classList.remove('btn-secondary');
      btnEdit.classList.add('btn-primary');
    } else {
      container.contentEditable = 'false';
      container.classList.remove('edit-mode');
      btnEdit.textContent = 'Edit';
      btnEdit.classList.remove('btn-primary');
      btnEdit.classList.add('btn-secondary');
    }

    this.updateUI();
  }

  async saveDocument() {
    try {
      const container = document.getElementById('document-container');
      const htmlContent = container.innerHTML;

      const response = await fetch(`${this.apiBase}/api/documents/${this.docId}/update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: htmlContent })
      });

      const data = await response.json();

      if (data.success) {
        this.showNotification('Document saved successfully', 'success');
        this.toggleEditMode();
      } else {
        throw new Error(data.error || 'Failed to save document');
      }
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async downloadDocument() {
    try {
      window.open(`${this.apiBase}/api/documents/${this.docId}/download`, '_blank');
    } catch (error) {
      this.showNotification('Failed to download document', 'error');
    }
  }

  zoomIn() {
    this.zoom = Math.min(this.zoom + 10, 200);
    this.applyZoom();
  }

  zoomOut() {
    this.zoom = Math.max(this.zoom - 10, 50);
    this.applyZoom();
  }

  applyZoom() {
    const container = document.getElementById('document-container');
    container.style.transform = `scale(${this.zoom / 100})`;
    container.style.transformOrigin = 'top center';
    document.getElementById('zoom-level').textContent = `${this.zoom}%`;
  }

  updateUI() {
    // Update viewer state
    document.body.classList.toggle('edit-mode', this.isEditMode);
  }

  showError(message) {
    const container = document.getElementById('document-container');
    container.innerHTML = `
      <div class="error-message">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <h2>Error Loading Document</h2>
        <p>${message}</p>
      </div>
    `;
  }

  showNotification(message, type = 'info') {
    // Simple notification
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 1rem 1.5rem;
      background: ${type === 'success' ? '#10b981' : '#ef4444'};
      color: white;
      border-radius: 0.5rem;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      z-index: 1000;
      animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }
}

// Initialize viewer when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.superdocViewer = new SuperDocViewer();
});

// Add animation keyframes
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`;
document.head.appendChild(style);
