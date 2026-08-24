import Editor from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerRetroAsm, LANGUAGE_ID as RETRO_ASM_ID } from './retroAsmLanguage';
import { attachIntellisenseMonaco } from '../../lib/intellisenseRegistry';

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 's' || ext === 'asm') return RETRO_ASM_ID;
  if (['ino', 'cpp', 'c', 'cc', 'h', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'hex') return 'plaintext';
  return 'plaintext';
}

export const CodeEditor = () => {
  const { files, activeFileId, setFileContent, theme, fontSize, manifestViewBoardId } =
    useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const activeFile = files.find((f) => f.id === activeFileId);

  // READ-ONLY libraries.json view (the file explorer's libraries.json entry).
  // Shows the active board's declared library manifest as plain-text JSON, live.
  // It is read-only on purpose: adding/removing libraries is done from the
  // Library Manager modal, which edits board.libraries (this just reflects it).
  if (manifestViewBoardId) {
    const b = boards.find((x) => x.id === manifestViewBoardId);
    const content = JSON.stringify({ libraries: b?.libraries ?? [] }, null, 2);
    return (
      <div style={{ height: '100%', width: '100%' }}>
        <Editor
          key="__libraries_json__"
          height="100%"
          language="json"
          theme={theme}
          value={content}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        // key forces a fresh editor instance per file (preserves undo/redo per file)
        key={activeFileId}
        height="100%"
        language={activeFile ? getLanguage(activeFile.name) : 'cpp'}
        theme={theme}
        value={activeFile?.content ?? ''}
        beforeMount={(monaco) => {
          // Register the 8080/Z80 assembly language once so Monaco knows how
          // to tokenize .s / .asm files when they're opened.
          registerRetroAsm(monaco);
          // Hand the monaco instance to the intellisense seam. Inert in OSS;
          // with the pro overlay loaded it registers the completion engine
          // (idempotent per monaco instance, so per-file remounts are fine).
          attachIntellisenseMonaco(monaco);
        }}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          minimap: { enabled: true },
          fontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          // Hover/suggest/signature widgets escape the editor's box as
          // position:fixed overlays. Without this, a marker hover wider
          // than the editor pane slides UNDER the simulator canvas next
          // to it (sibling stacking context) and can't be read.
          fixedOverflowWidgets: true,
          // Keep quick suggestions alive inside snippet placeholders:
          // completing `#include <|>` or an if-condition placeholder must
          // still offer suggestions while the snippet session is active.
          suggest: { snippetsPreventQuickSuggestions: false },
        }}
      />
    </div>
  );
};
