import { useEffect, useRef, useState } from 'react'
import './App.css'

const params = new URLSearchParams(window.location.search)
const DOC_ID = params.get('docId') || ''
const API_URL = (params.get('api_url') || window.location.origin).replace(/\/$/, '')
const DOCS_API_URL = (params.get('docs_api_url') || API_URL).replace(/\/$/, '')
const REFRESH_TOKEN = params.get('_owui_refresh') || params.get('v') || ''
const DOCUMENT_URL = DOC_ID
  ? `${DOCS_API_URL}/document/${DOC_ID}/original.docx${REFRESH_TOKEN ? `?v=${encodeURIComponent(REFRESH_TOKEN)}` : ''}`
  : ''

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

type BusyAction = 'save' | 'accept' | 'reject' | 'download' | null

function toDocxBlob(payload: unknown): Blob {
  if (payload instanceof Blob) return payload
  if (payload instanceof Uint8Array) {
    const copy = new Uint8Array(payload.byteLength)
    copy.set(payload)
    return new Blob([copy.buffer], { type: DOCX_MIME })
  }
  if (
    payload &&
    typeof payload === 'object' &&
    (payload as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    const arr = Uint8Array.from((payload as { data: number[] }).data)
    return new Blob([arr.buffer], { type: DOCX_MIME })
  }
  throw new Error('Unsupported DOCX export payload')
}

async function decideAllTrackedChanges(editor: any, decision: 'accept' | 'reject') {
  const trackChanges = editor?.doc?.trackChanges
  if (typeof trackChanges?.decide === 'function') {
    await trackChanges.decide({ decision, target: { scope: 'all' } })
    return
  }

  const commandName = decision === 'accept' ? 'acceptAllTrackedChanges' : 'rejectAllTrackedChanges'
  const command = editor?.commands?.[commandName]
  if (typeof command !== 'function') {
    throw new Error(`SuperDoc command unavailable: ${commandName}`)
  }

  for (let i = 0; i < 3; i += 1) {
    command.call(editor.commands)
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  }
}

function App() {
  const superdocRef = useRef<any>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [status, setStatus] = useState('Loading SuperDoc...')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)

  const getEditor = () => superdocRef.current?.activeEditor

  const exportDocxBlob = async (finalDoc: boolean) => {
    const editor = getEditor()
    if (!editor) throw new Error('Editor is not ready')

    if (typeof editor.exportDocx === 'function') {
      const payload = await editor.exportDocx(
        finalDoc
          ? { isFinalDoc: true, commentsType: 'clean' }
          : { isFinalDoc: false, commentsType: 'external' },
      )
      return toDocxBlob(payload)
    }

    if (typeof superdocRef.current?.export === 'function') {
      const payload = await superdocRef.current.export({ triggerDownload: false })
      return toDocxBlob(payload)
    }

    throw new Error('DOCX export is not available')
  }

  const saveBlobToServer = async (blob: Blob) => {
    if (!DOC_ID) throw new Error('Missing docId')
    const formData = new FormData()
    formData.append('file', blob, `${DOC_ID}.docx`)

    const response = await fetch(`${DOCS_API_URL}/document/${DOC_ID}/save`, {
      method: 'POST',
      body: formData,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `Save failed: HTTP ${response.status}`)
    }
  }

  const saveCurrentDocument = async () => {
    const blob = await exportDocxBlob(false)
    await saveBlobToServer(blob)
  }

  const handleSave = async () => {
    if (busy) return
    setBusy('save')
    setError('')
    try {
      await saveCurrentDocument()
      setStatus('Saved')
    } catch (err: any) {
      setError(err?.message || 'Save failed')
    } finally {
      setBusy(null)
    }
  }

  const handleDecision = async (decision: 'accept' | 'reject') => {
    if (busy) return
    setBusy(decision)
    setError('')
    try {
      const editor = getEditor()
      if (!editor) throw new Error('Editor is not ready')
      await decideAllTrackedChanges(editor, decision)
      const blob = await exportDocxBlob(true)
      await saveBlobToServer(blob)
      setStatus(decision === 'accept' ? 'All changes accepted and saved' : 'All changes rejected and saved')
    } catch (err: any) {
      setError(err?.message || 'Failed to resolve tracked changes')
    } finally {
      setBusy(null)
    }
  }

  const handleDownload = async () => {
    if (busy) return
    setBusy('download')
    setError('')
    try {
      await saveCurrentDocument()
      const link = document.createElement('a')
      link.href = `${DOCS_API_URL}/api/documents/${DOC_ID}/download`
      link.download = 'document.docx'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setStatus('Download started')
    } catch (err: any) {
      setError(err?.message || 'Download failed')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      if (!DOC_ID || !DOCUMENT_URL) {
        setError('Missing docId in viewer URL')
        setStatus('Unable to open document')
        return
      }

      try {
        const [{ SuperDoc }] = await Promise.all([
          import('superdoc'),
          import('superdoc/style.css'),
        ])
        if (cancelled) return

        const superdoc = new SuperDoc({
          selector: '#superdoc-editor',
          document: DOCUMENT_URL,
          documentMode: 'suggesting',
          role: 'editor',
          pagination: !isMobile,
          user: {
            name: 'OpenWebUI Assistant',
            email: 'assistant@openwebui.local',
          },
          modules: {
            toolbar: {
              selector: '#superdoc-toolbar',
              excludeItems: ['ai'],
            },
            trackChanges: {
              visible: true,
              mode: 'review',
              replacements: 'independent',
            },
            comments: {
              allowResolve: true,
            },
            contextMenu: {
              includeDefaultItems: true,
            },
          },
        } as any)

        superdocRef.current = superdoc
        setStatus('Ready')

        if (window.parent !== window) {
          window.parent.postMessage({ type: 'superdoc-ready', docId: DOC_ID }, '*')
        }
      } catch (err: any) {
        setError(err?.message || 'Failed to initialize SuperDoc')
        setStatus('Failed')
      }
    }

    void init()

    return () => {
      cancelled = true
      if (superdocRef.current) {
        superdocRef.current.destroy?.()
        superdocRef.current = null
      }
    }
  }, [isMobile])

  return (
    <div className={`app-container ${isMobile ? 'mobile' : 'desktop'}`}>
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">OD</span>
          <div>
            <h1>OpsUp Document Editor</h1>
            <p>{status}</p>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={handleSave} disabled={busy !== null}>
            {busy === 'save' ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={() => void handleDecision('accept')} disabled={busy !== null}>
            {busy === 'accept' ? 'Applying...' : 'Accept all'}
          </button>
          <button type="button" onClick={() => void handleDecision('reject')} disabled={busy !== null}>
            {busy === 'reject' ? 'Applying...' : 'Reject all'}
          </button>
          <button type="button" onClick={handleDownload} disabled={busy !== null}>
            {busy === 'download' ? 'Preparing...' : 'Download'}
          </button>
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div id="superdoc-toolbar" className="toolbar" />
      <main className="editor-shell">
        <div id="superdoc-editor" className="editor" />
      </main>
    </div>
  )
}

export default App
