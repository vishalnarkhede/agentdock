#!/usr/bin/env python3
"""Local MLX Whisper transcription server for voice input."""

import tempfile
import os
import struct
import wave
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import mlx_whisper

app = FastAPI()

MODEL = "mlx-community/whisper-large-v3-turbo"


def _make_silent_wav() -> str:
    """Create a tiny silent WAV file for model warmup."""
    path = os.path.join(tempfile.gettempdir(), "whisper_warmup.wav")
    with wave.open(path, "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(struct.pack("<h", 0) * 16000)  # 1s silence
    return path


print(f"Loading model {MODEL}...")
# Warm up: pre-load the model into memory with a silent audio file
_warmup_path = _make_silent_wav()
mlx_whisper.transcribe(_warmup_path, path_or_hf_repo=MODEL, language="en")
os.unlink(_warmup_path)
print("Model loaded. Ready for transcription.")


# Known Whisper hallucinations on silence/noise
HALLUCINATIONS = {
    "thank you", "thanks", "thank you.", "thanks.", "thank you for watching.",
    "thanks for watching.", "thank you for watching!", "thanks for watching!",
    "you", "bye.", "bye", "the end.", "the end", "so",
    "thank you very much.", "thank you very much",
}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        result = mlx_whisper.transcribe(
            tmp_path,
            path_or_hf_repo=MODEL,
            language="en",
        )
        text = result.get("text", "").strip()
        if text.lower() in HALLUCINATIONS:
            text = ""
        return JSONResponse({"text": text})
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8300)
