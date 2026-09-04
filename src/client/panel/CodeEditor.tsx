/** React lifecycle wrapper around one CodeMirror 6 EditorView. */

import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css as cssLanguage } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import type { SourceDocument } from '../../core/editor.ts'
import css from './panel.module.css'

interface CodeEditorProps {
  document: SourceDocument
  line: number | undefined
  onChange: (content: string) => void
}

export function CodeEditor({ document, line, onChange }: CodeEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const parent = host.current
    if (parent === null) return
    const view = new EditorView({
      parent,
      doc: document.content,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        languageFor(document.path),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
          '.cm-content': { padding: '10px 0' },
          '&.cm-focused': { outline: 'none' },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    if (line !== undefined && line >= 1) {
      const targetLine = Math.min(line, view.state.doc.lines)
      const anchor = view.state.doc.line(targetLine).from
      view.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      })
      view.focus()
    }
    return () => { view.destroy() }
  }, [document.path, document.hash, line])

  return <div ref={host} className={css.codeEditor} />
}

function languageFor(path: string) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'tsx' || ext === 'jsx' })
  }
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return html()
  if (['css', 'scss', 'less'].includes(ext)) return cssLanguage()
  if (ext === 'json' || ext === 'jsonc') return json()
  if (['md', 'markdown', 'mdx'].includes(ext)) return markdown()
  return []
}
