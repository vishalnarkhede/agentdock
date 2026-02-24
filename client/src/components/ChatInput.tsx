import { useState, useRef } from "react";
import { uploadFile } from "../api";

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    setUploading(true);
    const paths: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const path = await uploadFile(file);
        paths.push(path);
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }
    setUploading(false);
    if (paths.length > 0) {
      // Append file paths to current input value
      const pathsText = paths.join(" ");
      setValue((prev) => (prev ? prev + " " + pathsText : pathsText));
      inputRef.current?.focus();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  return (
    <div
      className="chat-input-bar"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.log"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        className="chat-attach-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || uploading}
        title="Attach file"
      >
        {uploading ? "..." : "+"}
      </button>
      <textarea
        ref={inputRef}
        className="chat-input"
        placeholder={uploading ? "Uploading..." : "Send a message to Claude..."}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={disabled}
        rows={1}
      />
      <button
        className="chat-send-btn"
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
      >
        send
      </button>
    </div>
  );
}
