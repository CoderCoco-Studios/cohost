import { useState, type Ref } from "react";

/** A byte count for a file's chosen size: `812 B`, `2.0 KiB`, `3.4 MiB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface FilePickerProps {
  /** The input's id: the `<label for>` of the surrounding `Field` names it. */
  id: string;
  accept?: string;
  onChange?: (file: File | null) => void;
  inputRef?: Ref<HTMLInputElement>;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * A file picker in the tokens' button look. The native `<input type="file">` stays (its picker, keyboard and screen-reader
 * semantics) and is laid invisibly over a "Choose file" face; the chosen file's name and size are shown beside it.
 */
export function FilePicker({ id, accept, onChange, inputRef, ...aria }: FilePickerProps) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <span className="filepick">
      <span className="filepick-btn">
        <input {...aria} id={id} ref={inputRef} type="file" className="filepick-input" accept={accept}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); onChange?.(f); }} />
        <span className="btn btn-sm filepick-face" aria-hidden="true">Choose file</span>
      </span>
      <span className={`filepick-name${file ? " chosen" : ""}`}>{file ? `${file.name} · ${fileSize(file.size)}` : "No file chosen"}</span>
    </span>
  );
}
