/**
 * SdCardPanel — the "SD Card" file panel shown in the component property dialog
 * for the microsd-card component.
 *
 * Free: the project's text files are auto-copied onto the card (handled
 * elsewhere, at simulation start). This panel is the PAID path: uploading your
 * own files — binaries included (images, audio, data) — which the editor cannot
 * accept any other way. Gated via `proSdCardGate`: a non-paid user clicking
 * "Add files" gets the upgrade prompt instead of the file picker.
 *
 * Files are persisted on the component as `properties.sdFiles`
 * (`{ name, contentB64 }[]`), so they travel with the project (.vlx) and feed
 * `buildProjectSdImage` on the next run.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  bytesToB64,
  SD_UPLOAD_MAX_BYTES,
  type UploadedSdFile,
} from '../../utils/sdCardFiles';
import { readFat16Image, type FatDirFile } from '../../utils/fatImage';
import { sdCardUploadAllowed, triggerSdCardUpgradePrompt } from '../../lib/proSdCardGate';
import { getEsp32Bridge, useSimulatorStore } from '../../store/useSimulatorStore';

interface SdCardPanelProps {
  files: UploadedSdFile[];
  onChange: (next: UploadedSdFile[]) => void;
  /** Board whose bridge mounts the card (the board inspector passes its own
   *  id; the standalone card component leaves it unset and the active board
   *  is used). Enables the live "Card contents" listing below the uploads. */
  boardId?: string | null;
}

function fileBytes(f: UploadedSdFile): number {
  const b = f.contentB64;
  const pad = b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b.length * 3) / 4) - pad);
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export const SdCardPanel: React.FC<SdCardPanelProps> = ({ files, onChange, boardId }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const total = files.reduce((s, f) => s + fileBytes(f), 0);

  // ── Live card contents: what is ON the card right now, including files
  //    the running sketch wrote (photos, logs). Read back from the bridge's
  //    card image and parsed with the same FAT16 layout the builder emits.
  //    null = no card mounted yet (never run).
  const [live, setLive] = useState<FatDirFile[] | null>(null);
  const running = useSimulatorStore((st) => st.running);

  const refreshLive = useCallback(() => {
    type SdBridge = { readSdImage?: () => Uint8Array | null };
    let bridge = boardId ? (getEsp32Bridge(boardId) as SdBridge | undefined) : undefined;
    if (!bridge?.readSdImage) {
      const activeId = useSimulatorStore.getState().activeBoardId;
      bridge = activeId ? (getEsp32Bridge(activeId) as SdBridge | undefined) : undefined;
    }
    const img = bridge?.readSdImage?.() ?? null;
    setLive(img ? readFat16Image(img) : null);
  }, [boardId]);

  // Read on open and whenever the run state flips (start mounts the card,
  // stop freezes its final contents).
  useEffect(() => {
    refreshLive();
  }, [refreshLive, running]);

  const download = (f: FatDirFile): void => {
    // Copy into a plain ArrayBuffer-backed view: TS's BlobPart rejects
    // Uint8Array<ArrayBufferLike> (the data may sit on a SharedArrayBuffer).
    const url = URL.createObjectURL(new Blob([new Uint8Array(f.data)]));
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const openPicker = (): void => {
    // Gate the PAID action: a non-paid user gets the upgrade prompt instead.
    if (!sdCardUploadAllowed()) {
      triggerSdCardUpgradePrompt();
      return;
    }
    inputRef.current?.click();
  };

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;
    const next = [...files];
    let running = total;
    for (const file of picked) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (running + bytes.length > SD_UPLOAD_MAX_BYTES) continue; // skip oversize
      running += bytes.length;
      const entry: UploadedSdFile = { name: file.name, contentB64: bytesToB64(bytes) };
      const idx = next.findIndex((f) => f.name.toLowerCase() === file.name.toLowerCase());
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
    }
    onChange(next);
  };

  const remove = (name: string): void => onChange(files.filter((f) => f.name !== name));

  return (
    <div className="sd-card-section">
      <div className="sd-card-label">
        SD Card files <span className="sd-card-paid">Paid</span>
      </div>
      {files.length === 0 && (
        <div className="sd-card-hint">
          Upload your own files (images, audio, data). The project's data files
          are added automatically; source files (.ino, .h, .cpp, .py) stay off
          the card.
        </div>
      )}
      {files.map((f) => (
        <div key={f.name} className="sd-card-file">
          <span className="sd-card-file-name" title={f.name}>
            {f.name}
          </span>
          <span className="sd-card-file-size">{humanSize(fileBytes(f))}</span>
          <button
            className="sd-card-file-remove"
            title="Remove"
            onClick={() => remove(f.name)}
          >
            x
          </button>
        </div>
      ))}
      <div className="sd-card-footer">
        <button className="sd-card-add" onClick={openPicker}>
          + Add files
        </button>
        <span className="sd-card-total">
          {humanSize(total)} / {humanSize(SD_UPLOAD_MAX_BYTES)}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handlePick}
      />

      {/* Live card contents: everything on the mounted card, sketch-written
          files included, each downloadable. */}
      <div className="sd-card-label sd-card-label--live">
        Card contents
        <button className="sd-card-refresh" onClick={refreshLive} title="Re-read the card">
          Refresh
        </button>
      </div>
      {live === null ? (
        <div className="sd-card-hint">
          Run the simulation to mount the card. Files the sketch writes (photos,
          logs) appear here and can be downloaded.
        </div>
      ) : live.length === 0 ? (
        <div className="sd-card-hint">The card is empty.</div>
      ) : (
        live.map((f) => (
          <div key={f.name} className="sd-card-file">
            <span className="sd-card-file-name" title={f.name}>
              {f.name}
            </span>
            <span className="sd-card-file-size">{humanSize(f.size)}</span>
            <button
              className="sd-card-file-download"
              title={`Download ${f.name}`}
              onClick={() => download(f)}
            >
              Download
            </button>
          </div>
        ))
      )}
    </div>
  );
};
