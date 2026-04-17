# Quick Install Guide - SuperDoc Tool for OpenWebUI

## 🚀 Fastest Way (2 minutes)

### Method 1: Via OpenWebUI UI (Recommended)

1. **Open OpenWebUI**: http://localhost:3000

2. **Go to Workspace**:
   - Click on **"Workspace"** icon in the left sidebar
   - Select **"Tools"**

3. **Create New Tool**:
   - Click **"+ Create Tool"** or **"Add Tool"**
   - Give it a name: `SuperDoc Document Editor`

4. **Paste the Tool Code**:
   - Open file: `openwebui-integration/superdoc_tool.py`
   - Copy ALL content
   - Paste into the tool editor
   - Click **"Save"**

5. **Enable the Tool**:
   - Make sure the tool is enabled (toggle switch ON)
   - It should now appear in your chat as an available tool

6. **Test It**:
   In chat, type:
   ```
   Create a car sale contract for a 2020 Tesla Model 3
   ```

   AI should automatically use the SuperDoc tool and return a link like:
   ```
   ✅ Document Created! 
   🔗 [Open in SuperDoc Viewer](http://localhost:8081/viewer/index.html?docId=xxx-xxx)
   ```

---

### Method 2: Via OpenWebUI API (Advanced)

If you have admin access, you can import via API:

```bash
# Get your API token from OpenWebUI:
# Settings → Account → API Keys → Generate

API_TOKEN="your-api-token-here"

# Import the tool
curl -X POST http://localhost:3000/api/v1/tools/create \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @openwebui-integration/tool-import.json
```

---

## ➕ Optional UX Upgrade: Message Action Button (Open Artifact)

Add an OpenWebUI **Action Function** so each assistant message gets a button that opens
SuperDoc preview (Artifact panel) without manually pressing the code block Preview button.

### Install via UI

1. Open **Workspace → Functions**
2. Click **Create Function**
3. Set `id`: `superdoc_artifact_launcher`
4. Set `name`: `SuperDoc Artifact Launcher`
5. Paste code from `openwebui-integration/superdoc_artifact_action.py`
6. Save and enable the function
7. In your model settings, enable this action for the model used in chat
   (or mark it global if you want it for all models)

### Install via API

```bash
API_TOKEN="your-api-token-here"

curl -X POST http://localhost:3000/api/v1/functions/create \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg id 'superdoc_artifact_launcher' \
    --arg name 'SuperDoc Artifact Launcher' \
    --arg content "$(cat openwebui-integration/superdoc_artifact_action.py)" \
    --arg description 'Message action button that opens SuperDoc Artifact preview' \
    '{id:$id,name:$name,content:$content,meta:{description:$description}}')"
```

Note: this action uses the existing SuperDoc HTML preview block from the tool output and
programmatically triggers the `Preview` button in the clicked message.

---

## 📋 What the Tool Does

### Available Functions:

1. **`create_document`** - Create new document from prompt
   - AI auto-calls when you say "create", "generate"
   
2. **`edit_document`** - Edit existing document
   - AI auto-calls when you say "edit", "modify", "change"
   - You need to provide Document ID

3. **`upload_document`** - Upload .docx file
   - AI auto-calls when you upload a file

4. **`list_documents`** - Show all your documents

---

## 💡 Usage Examples

### Create Document:
```
You: Create a contract for web development services
```
AI → calls `create_document` → returns viewer link

### Edit Document:
```
You: Edit document [docId: abc-123-def] to add payment terms
```
AI → calls `edit_document` → returns updated viewer link

### Upload & Edit:
```
You: [Upload file: agreement.docx]
     Make this more professional looking
```
AI → calls `upload_document` → calls `edit_document` → returns link

---

## ❓ Troubleshooting

**Tool doesn't appear in chat?**
- Refresh the page
- Check if tool is enabled in Workspace → Tools
- Make sure your LLM model supports function calling

**AI doesn't call the tool automatically?**
- Be explicit: "Use SuperDoc to create a document..."
- Check tool is properly imported (no syntax errors)

**Links don't work?**
- Verify SuperDoc is running: `docker ps | grep superdoc`
- Test: `curl http://localhost:8081/health`

---

## 🎯 Alternative: Manual Usage

If tool integration doesn't work, you can use SuperDoc directly:

### 1. Upload Document:
```bash
curl -X POST http://localhost:8081/api/documents/upload \
  -F "document=@/path/to/your/file.docx"
```

### 2. Create Document:
```bash
curl -X POST http://localhost:8081/api/documents/create \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a car sale contract", "template": "car-sale"}'
```

### 3. Edit Document:
```bash
curl -X POST http://localhost:8081/api/documents/{DOC_ID}/edit \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Make it more formal"}'
```

### 4. View Document:
Open in browser: `http://localhost:8081/viewer/index.html?docId={DOC_ID}`

---

**Full documentation**: See `openwebui-integration/README.md`
