# OpsUp Integration Summary

## 🔍 How It Currently Works

### What You Experienced:
1. ✅ You upload `.docx` to OpenWebUI chat
2. ✅ You write a prompt
3. ✅ LLM (Cloud.ru) processes it
4. ❌ **LLM returns PLAIN TEXT** (not integrated with SuperDoc)
5. ❌ SuperDoc is NOT involved in this flow

### Why This Happens:

**OpenWebUI** and **SuperDoc** are running as **SEPARATE SERVICES**:

```
OpenWebUI (localhost:3000)          SuperDoc (localhost:8081)
├─ Chat interface                   ├─ Document API
├─ LLM integration                  ├─ DOCX renderer
└─ File uploads                     └─ Viewer/editor
         │                                   │
         └────── NO CONNECTION! ────────────┘
```

When you upload a file to OpenWebUI:
- It's stored in OpenWebUI's internal storage
- LLM can read the text content
- But it's NOT sent to SuperDoc automatically
- LLM just returns text response

---

## ✅ How to Fix It: Integration Options

### Option 1: Tool-Based (✅ EASIEST - Recommended)

**What**: Create an OpenWebUI Tool that AI can call automatically

**How it works**:
```
User: "Create a car sale contract"
  ↓
AI sees keyword "create" + "contract"
  ↓
AI calls `create_document` tool
  ↓
Tool → SuperDoc API → Creates document
  ↓
SuperDoc returns: viewer URL
  ↓
AI returns: "✅ Created! [Open in Viewer](http://localhost:8081/viewer/...)"
  ↓
User clicks link → Full SuperDoc editor opens
```

**User Experience**:
- Chat shows: "✅ Document Created!"
- Clickable link appears
- Click → Opens SuperDoc in new tab
- Full editor with formatting, download, etc.

**Setup Time**: 2 minutes

**Implementation**: 
1. Go to OpenWebUI → Workspace → Tools
2. Create new tool
3. Paste code from `superdoc_tool.py`
4. Save & enable

---

### Option 2: Inline Embed via Artifacts (Complex)

**What**: Make AI return HTML that OpenWebUI renders as artifact

**How**:
```python
# AI returns special format:
<artifact type="html">
  <iframe src="http://localhost:8081/viewer/index.html?docId=xxx" 
          width="100%" height="600"></iframe>
</artifact>
```

**Problems**:
- ⚠️ CORS restrictions
- ⚠️ iframe blocking in OpenWebUI
- ⚠️ May require OpenWebUI code modification

---

### Option 3: Deep Integration (Most Work)

**What**: Fork OpenWebUI, add native SuperDoc support

**How**:
1. Clone OpenWebUI source code
2. Add SuperDoc as built-in feature
3. Modify chat UI to show document viewer inline
4. Add upload handler that sends to SuperDoc

**Time**: 1-2 weeks of development

---

## 🎯 RECOMMENDED: Start with Option 1

### Pros:
- ✅ Quick to implement (2 min setup)
- ✅ No code modification needed
- ✅ Works with any LLM
- ✅ Clear user flow

### Cons:
- ⚠️ Document opens in new tab (not embedded)
- ⚠️ Requires clicking a link

---

## 📋 What You Need to Do RIGHT NOW

### Step 1: Install the Tool (2 minutes)

1. **Open OpenWebUI**: http://localhost:3000

2. **Navigate to Tools**:
   - Left sidebar → **Workspace** → **Tools**
   - Click **"+ Create Tool"**

3. **Paste Tool Code**:
   - Open file: `openwebui-integration/superdoc_tool.py`
   - Copy ALL content
   - Paste into tool editor
   - Name: `SuperDoc Document Editor`
   - Click **Save**

4. **Enable It**:
   - Make sure toggle is ON

### Step 2: Test It

In chat, type:
```
Create a car sale contract for a 2020 Tesla Model 3, price $35,000
```

Expected AI response:
```
✅ Document Created Successfully!

📄 File: ai_generated_car-sale.docx

🔗 [👁️ Open in SuperDoc Viewer](http://localhost:8081/viewer/index.html?docId=xxx-xxx)

💡 Click the link to view or edit your document in the full-featured editor.

Document ID: `abc-123-def`
```

### Step 3: Click the Link

- Browser opens SuperDoc viewer
- Full document with formatting
- Can edit, download, etc.

---

## 🔄 Alternative: Manual Usage (No Tool Needed)

If tool doesn't work, you can use SuperDoc directly:

### Create Document via Terminal:
```bash
curl -X POST http://localhost:8081/api/documents/create \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a car sale contract for a 2020 Tesla Model 3",
    "template": "car-sale"
  }'
```

Response will include viewer URL like:
```json
{
  "viewerUrl": "/viewer/index.html?docId=abc-123-def"
}
```

Open in browser: **http://localhost:8081/viewer/index.html?docId=abc-123-def**

---

## 📊 Current File Structure

```
/Users/novergeme/Desktop/Projects/opsup/
├── superdoc/                      # Document engine (✅ Running)
│   ├── server.js
│   ├── services/
│   └── viewer/
├── mcp-server/                    # AI agent tools (✅ Running)
│   └── server.js
├── openwebui-integration/         # 🆕 Integration code
│   ├── superdoc_tool.py           # OpenWebUI Tool code
│   ├── INSTALL.md                 # Quick install guide
│   └── README.md                  # Full documentation
├── .env                           # Your configuration
├── docker-compose-simple.yml      # Docker setup
└── ...
```

---

## 🎯 Summary

| Service | Status | URL | Role |
|---------|--------|-----|------|
| OpenWebUI | ✅ Running | :3000 | Chat interface |
| SuperDoc | ✅ Running | :8081 | Document engine |
| MCP Server | ✅ Running | :8082 | AI agent tools |
| **Integration** | ⚠️ **Needs setup** | - | **Connect them** |

**Next Action**: Install the Tool in OpenWebUI (see Step 1 above)

**Time Required**: 2 minutes

**Result**: AI will automatically create/edit documents and provide clickable links to SuperDoc viewer!

---

## 💡 Future Enhancements

Once basic integration works:
1. Auto-detect uploads → send to SuperDoc
2. Inline preview in chat
3. Real-time sync
4. Version history
5. Collaborative editing

**Full docs**: See `openwebui-integration/INSTALL.md`
