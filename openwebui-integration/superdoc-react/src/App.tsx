import { useEffect, useRef, useState } from 'react'
import type { SuperDoc as SuperDocType } from 'superdoc'
import './App.css'

const urlParams = new URLSearchParams(window.location.search)
const ENV = import.meta.env as Record<string, string | boolean | undefined>
const DOC_ID = urlParams.get('docId')
const DOCS_API_URL = urlParams.get('docs_api_url') || 'http://localhost:8081'
const API_URL = urlParams.get('api_url') || 'http://localhost:8081'
const DOC_VERSION = urlParams.get('v')
const COLLAB_QUERY = String(urlParams.get('collab') || '').toLowerCase()
const COLLAB_ENABLED = (() => {
  if (COLLAB_QUERY === '1' || COLLAB_QUERY === 'true') return true
  const raw = ENV.VITE_SUPERDOC_COLLAB_ENABLED ?? ENV.NEXT_PUBLIC_SUPERDOC_COLLAB_ENABLED ?? 'false'
  return String(raw).toLowerCase() === 'true'
})()
const COLLAB_API_URL = String(
  urlParams.get('collab_api_url') || ENV.VITE_SUPERDOC_COLLAB_URL || 'http://localhost:5005'
)
const COLLAB_PROVIDER = String(
  urlParams.get('collab_provider') || ENV.VITE_SUPERDOC_COLLAB_PROVIDER || 'hocuspocus'
)
const COLLAB_WS_URL = String(
  urlParams.get('collab_ws_url') || ENV.VITE_SUPERDOC_COLLAB_WS_URL || 'ws://localhost:1234'
)
const DOCUMENT_URL = DOC_ID
  ? `${DOCS_API_URL}/document/${DOC_ID}/original.docx${DOC_VERSION ? `?v=${encodeURIComponent(DOC_VERSION)}` : ''}`
  : '/testdoc.docx'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const normalizeWhitespace = (value: string) =>
  String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getEditorPlainText = (editor: any) => {
  try {
    const doc = editor?.state?.doc
    const size = doc?.content?.size ?? 0
    if (!doc || size <= 0 || typeof doc.textBetween !== 'function') return ''
    return String(doc.textBetween(0, size, '\n', '\n') || '')
  } catch {
    return ''
  }
}

const buildSearchCandidates = (findText: string) => {
  const raw = String(findText || '').trim()
  if (!raw) return []
  const normalized = normalizeWhitespace(raw)
  const nbspVariant = normalized.replace(/ /g, '\u00a0')
  const compactVariant = raw.replace(/\u00a0/g, ' ')
  const candidates = [raw, normalized, nbspVariant, compactVariant]
  return [...new Set(candidates.filter(Boolean))]
}

const fixSpacingXml = (documentXml: string) => {
  let updatedXml = documentXml
  updatedXml = updatedXml.replace(
    /<w:spacing\s+w:before="0"\s+w:after="0"\s+w:lineRule="auto"\s*\/>/g,
    '<w:spacing w:before="0" w:beforeAutospacing="0" w:after="0" w:afterAutospacing="0"/>'
  )
  updatedXml = updatedXml.replace(
    /<w:spacing\s+w:before="100"\s+w:after="100"\s+w:lineRule="auto"\s*\/>/g,
    '<w:spacing w:before="0" w:beforeAutospacing="0" w:after="0" w:afterAutospacing="0"/>'
  )
  updatedXml = updatedXml.replace(
    /<w:spacing\s+w:lineRule="auto"\s*\/>/g,
    '<w:spacing w:before="0" w:beforeAutospacing="0" w:after="0" w:afterAutospacing="0"/>'
  )
  updatedXml = updatedXml.replace(/<w:ind\s+w:left="0"\s*\/>/g, '')
  return updatedXml
}

const acceptAllTrackedChanges = async (editor: any) => {
  if (!editor?.commands?.acceptAllTrackedChanges) {
    console.warn('[superdoc] acceptAllTrackedChanges() недоступна')
    return false
  }
  for (let i = 0; i < 3; i += 1) {
    editor.commands.acceptAllTrackedChanges()
    await sleep(100)
  }
  await sleep(300)
  console.log('[superdoc] acceptAllTrackedChanges() выполнена')
  return true
}

const getSelectionPosition = (editor: any, position: 'start' | 'end') => {
  const docSize = editor?.state?.doc?.content?.size ?? 1
  if (position === 'start') {
    return 1
  }
  return Math.max(1, docSize)
}

const getCollabUserId = () => {
  try {
    const key = 'superdoc-collab-user-id'
    const existing = window.localStorage.getItem(key)
    if (existing) return existing
    const next = `collab_${Math.random().toString(36).slice(2, 10)}`
    window.localStorage.setItem(key, next)
    return next
  } catch {
    return `collab_${Math.random().toString(36).slice(2, 10)}`
  }
}

const requestCollabToken = async (docId: string) => {
  const userId = getCollabUserId()
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 4000)
  const response = await fetch(`${COLLAB_API_URL}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc_id: docId,
      user_id: userId,
      role: 'editor',
    }),
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeoutId))
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.success || !payload?.token) {
    throw new Error(payload?.error || `collab token request failed: HTTP ${response.status}`)
  }
  return {
    token: String(payload.token),
    websocketUrl: String(payload.websocket_url || COLLAB_WS_URL),
    provider: String(payload.provider || COLLAB_PROVIDER || 'hocuspocus'),
    userId,
  }
}

const applyReplaceAction = (editor: any, findText: string, replaceText: string, replaceAll = false) => {
  if (!findText || typeof findText !== 'string') return { count: 0, candidate: '' }

  const candidates = buildSearchCandidates(findText)
  for (const candidate of candidates) {
    const matches = editor?.commands?.search?.(candidate, { highlight: false }) || []
    if (!Array.isArray(matches) || matches.length === 0) continue

    const targets = replaceAll ? matches : [matches[0]]
    const orderedTargets = [...targets].sort((a, b) => (b.from || 0) - (a.from || 0))
    let replacedCount = 0

    for (const target of orderedTargets) {
      if (typeof target?.from !== 'number' || typeof target?.to !== 'number') continue
      const selected = editor?.commands?.setTextSelection?.({ from: target.from, to: target.to })
      if (selected === false) continue
      const inserted = editor?.commands?.insertContent?.(replaceText || '')
      if (inserted !== false) {
        replacedCount += 1
      }
    }
    editor?.commands?.search?.('', { highlight: false })
    if (replacedCount > 0) {
      return { count: replacedCount, candidate }
    }
  }

  return { count: 0, candidate: '' }
}

const applyInsertContentAction = (editor: any, action: any) => {
  const content = action?.content
  if (!content) return 0

  const position = action?.position as 'start' | 'end' | 'cursor' | undefined
  if (position === 'start' || position === 'end') {
    const pos = getSelectionPosition(editor, position)
    editor?.commands?.setTextSelection?.({ from: pos, to: pos })
  }

  editor?.commands?.insertContent?.(content)
  return 1
}

const applySuperDocActions = async (editor: any, actions: any[]) => {
  const warnings: string[] = []
  let appliedActions = 0
  let appliedUnits = 0

  if (editor?.commands?.enableTrackChanges) {
    editor.commands.enableTrackChanges()
  }

  for (const action of actions) {
    const type = String(action?.type || '')
    try {
      if (type === 'replace') {
        const replaced = applyReplaceAction(editor, action?.find || '', action?.replace || '', false)
        if (replaced.count > 0) {
          appliedActions += 1
          appliedUnits += replaced.count
        }
        else warnings.push(`replace: "${String(action?.find || '').slice(0, 80)}" не найден`)
        continue
      }
      if (type === 'replaceAll') {
        const replaced = applyReplaceAction(editor, action?.find || '', action?.replace || '', true)
        if (replaced.count > 0) {
          appliedActions += 1
          appliedUnits += replaced.count
        }
        else warnings.push(`replaceAll: "${String(action?.find || '').slice(0, 80)}" не найден`)
        continue
      }
      if (type === 'insertContent') {
        const inserted = applyInsertContentAction(editor, action)
        if (inserted > 0) {
          appliedActions += 1
          appliedUnits += inserted
        }
        else warnings.push('insertContent: пустой content')
        continue
      }
      warnings.push(`Неподдерживаемое действие: ${type || 'unknown'}`)
    } catch (error: any) {
      warnings.push(`Ошибка действия ${type}: ${error?.message || 'unknown error'}`)
    }
  }

  return { appliedActions, appliedUnits, warnings }
}

const setEditorReadOnly = (editor: any, locked: boolean) => {
  if (!editor) return false
  const editable = !locked
  try {
    if (typeof editor.setEditable === 'function') {
      editor.setEditable(editable)
      return true
    }
  } catch {
    // noop
  }
  try {
    if (typeof editor.commands?.setEditable === 'function') {
      editor.commands.setEditable(editable)
      return true
    }
  } catch {
    // noop
  }
  try {
    if (locked && typeof editor.commands?.disableEditing === 'function') {
      editor.commands.disableEditing()
      return true
    }
    if (!locked && typeof editor.commands?.enableEditing === 'function') {
      editor.commands.enableEditing()
      return true
    }
  } catch {
    // noop
  }
  return false
}

function App() {
  const superdocRef = useRef<SuperDocType | null>(null)
  const pendingReadOnlyRef = useRef<boolean | null>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const tryApplyPendingReadOnly = () => {
      if (pendingReadOnlyRef.current === null) return
      const editor = (superdocRef.current as any)?.activeEditor
      if (!editor) return
      setEditorReadOnly(editor, pendingReadOnlyRef.current)
    }

    const timer = window.setInterval(tryApplyPendingReadOnly, 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false

    const initSuperDoc = async () => {
      if (superdocRef.current || cancelled) return

      const [{ SuperDoc }] = await Promise.all([
        import('superdoc'),
        import('superdoc/style.css'),
      ])

      if (cancelled) return

      const superdocConfig: any = {
        selector: '#superdoc-editor',
        toolbar: '#superdoc-toolbar',
        document: DOCUMENT_URL,
        documentMode: 'suggesting',
        role: 'editor',
        pagination: !isMobile,
        toolbarTexts: {
          bold: 'Жирный',
          italic: 'Курсив',
          underline: 'Подчёркнутый',
          strikethrough: 'Зачёркнутый',
          fontFamily: 'Шрифт',
          fontSize: 'Размер шрифта',
          color: 'Цвет текста',
          highlight: 'Цвет выделения',
          textAlign: 'Выравнивание',
          bulletList: 'Маркированный список',
          numberedList: 'Нумерованный список',
          indentLeft: 'Уменьшить отступ',
          indentRight: 'Увеличить отступ',
          link: 'Ссылка',
          image: 'Изображение',
          table: 'Вставить таблицу',
          tableActions: 'Параметры таблицы',
          addRowBefore: 'Вставить строку выше',
          addRowAfter: 'Вставить строку ниже',
          addColumnBefore: 'Вставить столбец слева',
          addColumnAfter: 'Вставить столбец справа',
          deleteRow: 'Удалить строку',
          deleteColumn: 'Удалить столбец',
          deleteTable: 'Удалить таблицу',
          mergeCells: 'Объединить ячейки',
          splitCell: 'Разделить ячейку',
          transparentBorders: 'Прозрачные границы',
          fixTables: 'Исправить таблицы',
          undo: 'Отменить',
          redo: 'Повторить',
          search: 'Поиск',
          zoom: 'Масштаб',
          clearFormatting: 'Очистить форматирование',
          copyFormat: 'Копировать формат',
          lineHeight: 'Межстрочный интервал',
          formatText: 'Форматирование текста',
          ruler: 'Линейка',
          pageBreak: 'Разрыв страницы',
          trackChanges: 'Отслеживание изменений',
          trackChangesAccept: 'Принять изменения',
          trackChangesReject: 'Отклонить изменения',
          trackChangesOriginal: 'Показать оригинал',
          trackChangesFinal: 'Показать результат',
          ai: 'AI генерация текста',
          documentEditingMode: 'Редактирование',
          documentSuggestingMode: 'Предложения',
          documentViewingMode: 'Просмотр',
          documentEditingModeDescription: 'Редактирование документа',
          documentSuggestingModeDescription: 'Режим предложений',
          documentViewingModeDescription: 'Просмотр документа',
          linkedStyles: 'Связанные стили',
        },
      } as any

      let collabWarning = ''
      if (COLLAB_ENABLED && DOC_ID) {
        try {
          const collabToken = await requestCollabToken(DOC_ID)
          superdocConfig.user = {
            name: 'Lentulen User',
            email: `${collabToken.userId}@lentulen.local`,
          }
          superdocConfig.modules = {
            ...(superdocConfig.modules || {}),
            collaboration: {
              providerType: collabToken.provider,
              url: collabToken.websocketUrl,
              token: collabToken.token,
            },
          }
          console.log('[superdoc] collaboration pilot enabled', {
            room: DOC_ID,
            provider: collabToken.provider,
            websocketUrl: collabToken.websocketUrl,
          })
        } catch (error: any) {
          collabWarning = error?.message || 'failed to initialize collaboration'
          console.warn('[superdoc] collaboration disabled:', collabWarning)
        }
      }

      const superdoc = new SuperDoc(superdocConfig as any)

      // Disable custom context menu
      superdoc.setDisableContextMenu(true)

      superdocRef.current = superdoc

      if (window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'superdoc-ready',
            docId: DOC_ID,
            collaboration_enabled: Boolean(superdocConfig.modules?.collaboration),
          },
          '*'
        )
        if (collabWarning) {
          window.parent.postMessage(
            {
              type: 'superdoc-collab-warning',
              docId: DOC_ID,
              warning: collabWarning,
            },
            '*'
          )
        }
      }
    }

    // Restore default browser context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.stopPropagation()
    }

    const editorEl = document.getElementById('superdoc-editor')
    editorEl?.addEventListener('contextmenu', handleContextMenu, true)

    initSuperDoc()

    return () => {
      cancelled = true
      editorEl?.removeEventListener('contextmenu', handleContextMenu, true)
      if (superdocRef.current) {
        superdocRef.current.destroy()
        superdocRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const postToParent = (payload: Record<string, unknown>) => {
      if (window.parent !== window) {
        window.parent.postMessage(payload, '*')
      }
    }

    const exportDocumentXml = async (editor: any, acceptTrackedChanges: boolean) => {
      if (acceptTrackedChanges) {
        await acceptAllTrackedChanges(editor)
      }

      const documentXml = await editor.exportDocx({
        isFinalDoc: acceptTrackedChanges,
        commentsType: acceptTrackedChanges ? 'clean' : 'external',
        exportXmlOnly: true,
        fieldsHighlightColor: '',
      })

      if (!documentXml || typeof documentXml !== 'string') {
        throw new Error('Не удалось экспортировать document.xml')
      }

      return fixSpacingXml(documentXml)
    }

    const saveXmlToServer = async (docId: string, documentXml: string) => {
      const formData = new FormData()
      formData.append('document_xml', documentXml)
      formData.append('doc_id', docId)

      const response = await fetch(`${DOCS_API_URL}/document/${docId}/save-xml`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Ошибка сохранения: ${response.status}`)
      }
    }

    const toDocxBlob = (payload: any): Blob => {
      if (payload instanceof Blob) {
        return payload
      }
      if (payload instanceof Uint8Array) {
        const copy = new Uint8Array(payload.byteLength)
        copy.set(payload)
        return new Blob([copy.buffer], { type: DOCX_MIME })
      }
      if (
        payload &&
        typeof payload === 'object' &&
        payload.type === 'Buffer' &&
        Array.isArray(payload.data)
      ) {
        const arr = Uint8Array.from(payload.data)
        return new Blob([arr.buffer], { type: DOCX_MIME })
      }
      throw new Error('Некорректный формат DOCX при экспорте')
    }

    const saveDocxToServer = async (docId: string, docxPayload: any) => {
      const docxBlob = toDocxBlob(docxPayload)
      const formData = new FormData()
      formData.append('file', docxBlob, `${docId}.docx`)
      const response = await fetch(`${DOCS_API_URL}/document/${docId}/save`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        throw new Error(`Ошибка сохранения DOCX: ${response.status}`)
      }
    }

    const buildFallbackModifications = (actions: any[]) => {
      return (actions || []).flatMap((action: any) => {
        const type = String(action?.type || '')
        const find = String(action?.find || '').trim()
        if ((type === 'replace' || type === 'replaceAll') && find) {
          return [
            {
              old_value: find,
              new_value: String(action?.replace ?? ''),
              context: 'superdoc-ai-fallback',
            },
          ]
        }
        return []
      })
    }

    const applyServerSideFallback = async (docId: string, actions: any[]) => {
      const modifications = buildFallbackModifications(actions)
      if (modifications.length === 0) {
        throw new Error('Нет replace-действий для fallback')
      }

      const response = await fetch(`${DOCS_API_URL}/edit_docx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: docId,
          modifications,
        }),
      })

      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || `Ошибка fallback /edit_docx: ${response.status}`)
      }

      return payload
    }

    const handleAiEdit = async (editor: any, prompt: string, requestId?: string) => {
      if (!DOC_ID) {
        throw new Error('docId отсутствует в URL')
      }
      if (!prompt?.trim()) {
        throw new Error('Пустой запрос редактирования')
      }

      const textBefore = getEditorPlainText(editor)
      const textBeforeNormalized = normalizeWhitespace(textBefore)

      const aiResponse = await fetch(`${API_URL}/ai/edit_document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_id: DOC_ID,
          prompt,
          document_text: textBefore,
        }),
      })

      const aiData = await aiResponse.json().catch(() => ({}))
      if (!aiResponse.ok || !aiData?.success) {
        throw new Error(aiData?.error || `Ошибка AI endpoint: ${aiResponse.status}`)
      }

      // Server-side headless execution path: changes are already persisted on backend.
      if (aiData?.server_executed || aiData?.refreshDoc === true) {
        postToParent({
          type: 'superdoc-ai-edit-result',
          requestId,
          result: {
            success: true,
            refreshDoc: true,
            message: aiData?.message || 'Changes were applied through server-side headless engine.',
            summary: aiData?.summary || 'Изменения применены на сервере.',
            history_saved: Boolean(aiData?.history_saved),
            warnings: Array.isArray(aiData?.warnings) ? aiData.warnings : [],
          },
        })
        return
      }

      const actionsFromResults = Array.isArray(aiData?.results)
        ? aiData.results
            .filter((item: any) => item?.originalText)
            .map((item: any) => ({
              type: 'replace',
              find: item.originalText,
              replace: item.suggestedText || '',
            }))
        : []

      const actions = Array.isArray(aiData?.actions) && aiData.actions.length > 0
        ? aiData.actions
        : actionsFromResults

      const { appliedActions, appliedUnits, warnings } = await applySuperDocActions(editor, actions)
      const textAfter = getEditorPlainText(editor)
      const textChanged = normalizeWhitespace(textAfter) !== textBeforeNormalized
      const hasReplaceActions = actions.some((action: any) => {
        const type = String(action?.type || '')
        return type === 'replace' || type === 'replaceAll'
      })

      if (appliedActions <= 0 || !textChanged) {
        if (hasReplaceActions) {
          const fallbackResult = await applyServerSideFallback(DOC_ID, actions)
          postToParent({
            type: 'superdoc-ai-edit-result',
            requestId,
            result: {
              success: true,
              refreshDoc: true,
              message: 'Changes were applied through docs-service fallback (/edit_docx).',
              summary:
                aiData?.summary ||
                fallbackResult?.message ||
                'Изменения применены через fallback.',
              history_saved: false,
              warnings: [...warnings, 'Локальное применение в SuperDoc не изменило текст. Использован fallback /edit_docx.'],
            },
          })
          return
        }
        if (appliedActions <= 0) {
          throw new Error('No tools were successfully executed by the model')
        }
        throw new Error('Изменения не применились к документу.')
      }

      // Для AI-редактирования сохраняем уже принятые изменения,
      // но сохраняем ПОЛНЫЙ DOCX (а не только document.xml),
      // чтобы корректно фиксировать правки в режиме suggesting/track changes.
      await acceptAllTrackedChanges(editor)
      const docxPayload = await editor.exportDocx({
        isFinalDoc: true,
        commentsType: 'clean',
        fieldsHighlightColor: '',
      })
      await saveDocxToServer(DOC_ID, docxPayload)

      postToParent({
        type: 'superdoc-ai-edit-result',
        requestId,
        result: {
          success: true,
          refreshDoc: false,
          message: 'Changes were applied through SuperDoc tool-calling.',
          summary: aiData?.summary || `Применено действий: ${appliedActions}, изменений: ${appliedUnits}`,
          history_saved: false,
          warnings,
        },
      })
    }
    // Explicitly keep compiled helper references for legacy maintenance without runtime usage.
    void handleAiEdit

    const handleMessage = async (event: MessageEvent) => {
      const messageType = event?.data?.type
      if (!messageType) return

      const superdoc = superdocRef.current
      const editor = (superdoc as any)?.activeEditor

      if (messageType === 'superdoc-set-readonly') {
        const locked = Boolean(event.data?.locked)
        pendingReadOnlyRef.current = locked
        if (!editor) {
          return
        }
        setEditorReadOnly(editor, locked)
        return
      }

      if (messageType === 'save-document') {
        if (!DOC_ID) {
          postToParent({
            type: 'save-result',
            success: false,
            error: 'docId отсутствует в URL',
          })
          return
        }

        if (!editor) {
          postToParent({
            type: 'save-result',
            success: false,
            error: 'Редактор не доступен',
          })
          return
        }

        try {
          const xml = await exportDocumentXml(editor, true)
          await saveXmlToServer(DOC_ID, xml)

          postToParent({
            type: 'save-result',
            success: true,
            message: 'Документ успешно сохранен',
          })
        } catch (error: any) {
          postToParent({
            type: 'save-result',
            success: false,
            error: error?.message || 'Ошибка сохранения',
          })
        }

        return
      }

      if (messageType === 'superdoc-ai-edit') {
        postToParent({
          type: 'superdoc-ai-edit-result',
          requestId: event.data?.requestId,
          result: {
            success: false,
            error: 'Client-side AI applier disabled. Use server-side /ai/edit_document/submit.',
          },
        })
        return
      }

      if (messageType === 'download-docx') {
        if (!DOC_ID) {
          postToParent({
            type: 'download-result',
            success: false,
            format: 'docx',
            error: 'docId отсутствует в URL',
          })
          return
        }

        if (!editor) {
          postToParent({
            type: 'download-result',
            success: false,
            format: 'docx',
            error: 'Редактор не доступен',
          })
          return
        }

        try {
          await acceptAllTrackedChanges(editor)

          const updatedDocs = await editor.exportDocx({
            isFinalDoc: true,
            commentsType: 'clean',
            getUpdatedDocs: true,
            fieldsHighlightColor: '',
          })

          if (!updatedDocs || typeof updatedDocs !== 'object') {
            throw new Error('Не удалось экспортировать файлы')
          }

          const filesToKeepOriginal = [
            'word/styles.xml',
            'word/settings.xml',
            'word/numbering.xml',
            'word/fontTable.xml',
          ]

          const filteredDocs: Record<string, string> = {}
          for (const [filename, content] of Object.entries(updatedDocs)) {
            if (filesToKeepOriginal.includes(filename)) continue
            filteredDocs[filename] = content as string
          }

          if (filteredDocs['word/document.xml']) {
            filteredDocs['word/document.xml'] = fixSpacingXml(
              filteredDocs['word/document.xml']
            )
          }

          const formData = new FormData()
          formData.append('updated_docs', JSON.stringify(filteredDocs))
          formData.append('filename', event.data?.filename || 'document')

          const response = await fetch(
            `${DOCS_API_URL}/document/${DOC_ID}/download-from-superdoc`,
            {
              method: 'POST',
              body: formData,
            }
          )

          if (!response.ok) {
            throw new Error(`Ошибка скачивания: ${response.status}`)
          }

          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `${event.data?.filename || 'document'}.docx`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(url)

          postToParent({
            type: 'download-result',
            success: true,
            format: 'docx',
          })
        } catch (error: any) {
          postToParent({
            type: 'download-result',
            success: false,
            format: 'docx',
            error: error?.message || 'Ошибка скачивания',
          })
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  return (
    <div className={`app-container ${isMobile ? 'mobile' : 'desktop'}`}>
      <div className="toolbar-container">
        <div id="superdoc-toolbar" className="superdoc-toolbar"></div>
      </div>

      <main className="editor-container">
        <div id="superdoc-editor" className="superdoc-editor"></div>
      </main>
    </div>
  )
}

export default App
