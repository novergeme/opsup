# OpenWebUI + SuperDoc Integration Guide

## 📋 How It Works Now

### Current Architecture:

```
User (Browser: localhost:3000)
         │
         ▼
    OpenWebUI Chat
         │
         ├─── Uploads .docx ────────────────────────────────┐
         │                                                   │
         ▼                                                   ▼
    LLM (Cloud.ru)                                    SuperDoc API
    Returns text response                        (localhost:8081)
                                                      │
                                                      ▼
                                               Renders document
                                               Returns viewer URL
                                                      │
                                                      ▼
                                              http://localhost:8081
                                              /viewer/index.html
                                              ?docId=xxx-xxx-xxx
```

### What Happens When You Send a Message:

1. **You upload a .docx file** → OpenWebUI receives it as attachment
2. **You write a prompt** → LLM (Cloud.ru) processes it
3. **LLM returns text** → Shows in chat as plain text
4. **SuperDoc is NOT involved** → It's running separately on port 8081

---

## 🔧 Integration Options

### ✅ Option 1: Tool-Based Integration (RECOMMENDED - Easy)

Create an OpenWebUI **Tool** that AI can call to interact with SuperDoc.

**How it works:**
1. User uploads document to chat
2. User writes: "Edit this document to make it more professional"
3. AI calls the `edit_document` tool automatically
4. Tool sends document to SuperDoc API
5. SuperDoc edits it and returns viewer URL
6. AI returns message with clickable link: "[Open in SuperDoc Viewer](http://...)"
7. User clicks link → Full document editor opens

**Pros:**
- ✅ Easy to implement
- ✅ No OpenWebUI code modification
- ✅ Works with any LLM that supports function calling
- ✅ Clear user experience

**Cons:**
- ⚠️ Requires clicking a link (not embedded)
- ⚠️ Document opens in new tab, not inside chat

---

### 🔥 Option 2: Pipe Function Integration (Advanced)

Create a custom **Pipe** that intercepts messages and automatically:
1. Detects document uploads
2. Sends to SuperDoc
3. Returns viewer URL in response

**How to install:**
1. Go to OpenWebUI → Workspace → Functions
2. Create new function
3. Paste the Python code from `superdoc_tool.py`
4. Enable it

---

### 🎯 Option 3: Inline HTML Artifact (Best UX - Complex)

Use OpenWebUI's artifact system to embed SuperDoc viewer directly in chat.

**How it works:**
1. AI returns a special HTML block:
   ```html
   <iframe src="http://localhost:8081/viewer/index.html?docId=xxx" 
           width="100%" height="600px"></iframe>
   ```
2. OpenWebUI renders it as an artifact
3. User sees editor directly in chat!

**Problem:**
- ⚠️ iframe security restrictions (CORS)
- ⚠️ Requires OpenWebUI frontend customization
- ⚠️ May not work with current version

---

## 🚀 Implementation: Option 1 (Starting Now)

### Step 1: Configure OpenWebUI Tool

**In OpenWebUI UI:**

1. **Click Workspace (left sidebar)**
2. **Go to Tools**
3. **Click "Create Tool"**
4. **Paste the tool code** (from `superdoc_tool.py`)
5. **Save**

**OR via API:**

```bash
cd /Users/novergeme/Desktop/Projects/opsup

# Import the tool via OpenWebUI API
curl -X POST http://localhost:3000/api/v1/tools/import \
  -H "Authorization: Bearer YOUR_OPENWEBUI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "'"$(cat openwebui-integration/superdoc_tool.py)"'"
  }'
```

### Step 2: Use It

**Creating a document:**
```
User: Create a car sale contract for a 2020 Tesla Model 3, price $35,000
```

AI will call `create_document` tool and return:
```
✅ Document Created Successfully!

📄 File: ai_generated_car-sale.docx

🔗 [👁️ Open in SuperDoc Viewer](http://localhost:8081/viewer/index.html?docId=xxx)

💡 Click the link to view or edit your document in the full-featured editor.
```

**Editing a document:**
```
User: Edit this document to make the language more formal
```

AI will call `edit_document` tool and return updated viewer link.

**Uploading existing document:**
1. Upload .docx file in chat
2. Say: "Edit this document to improve formatting"
3. AI uses the upload tool automatically

---

## 📊 SuperDoc API Endpoints

All available from OpenWebUI:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/documents/upload` | POST | Upload .docx file |
| `/api/documents/create` | POST | Create document from prompt |
| `/api/documents` | GET | List all documents |
| `/api/documents/{id}/edit` | POST | Edit document with AI |
| `/api/documents/{id}/html` | GET | Get HTML preview |
| `/api/documents/{id}/download` | GET | Download .docx |
| `/viewer/index.html?docId={id}` | GET | **Full Document Viewer** |

---

## 🎯 Next Steps for Better Integration

### Short-term (This Week):
1. ✅ Install Tool in OpenWebUI (via UI)
2. ✅ Test document creation
3. ✅ Test editing workflow
4. ✅ Verify links work

### Medium-term (Next Week):
1. Add auto-detection of uploads → auto-send to SuperDoc
2. Create custom OpenWebUI Function (Pipe)
3. Improve viewer UI/UX
4. Add document preview thumbnails

### Long-term (Future):
1. Fork OpenWebUI to add native SuperDoc integration
2. Embed iframe in artifacts
3. Real-time sync between chat and editor
4. Version control in UI

---

## 🔍 Troubleshooting

### Tool not appearing in OpenWebUI?
- Make sure you're using OpenWebUI v0.4.0+
- Check Workspace → Functions → Enable "Tools"
- Refresh the page

### Links not working?
- Check SuperDoc is running: `docker ps | grep superdoc`
- Test directly: `curl http://localhost:8081/health`
- Check CORS settings in SuperDoc

### AI not calling the tool?
- Make sure your LLM supports function calling
- Most modern models (GPT-4, Claude) support it
- Try being explicit: "Use the SuperDoc tool to create..."

---

## 💡 Pro Tips

1. **Always include Document ID** when asking for edits:
   ```
   User: Edit document [docId: xxx-xxx-xxx] to make it more professional
   ```

2. **Create templates** for common documents:
   ```
   User: Create a standard NDA agreement using the contract template
   ```

3. **Batch operations** - upload multiple files, then:
   ```
   User: Edit all uploaded documents to add today's date
   ```

---

Need help? Check `STATUS.md` and `QUICKSTART.md`
