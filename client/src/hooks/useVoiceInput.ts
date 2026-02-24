import { useState, useRef, useCallback } from "react";
import { transcribeAudio } from "../api";

export type VoiceState = "idle" | "recording" | "transcribing";

interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  silenceThreshold?: number;
  silenceDuration?: number;
  maxDuration?: number;
}

export function useVoiceInput({
  onTranscript,
  silenceThreshold = 0.01,
  silenceDuration = 1500,
  maxDuration = 60000,
}: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    silenceTimerRef.current = null;
    maxTimerRef.current = null;
    rafRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    cleanup();

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setState("transcribing");
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];

        try {
          const text = await transcribeAudio(blob);
          if (text) {
            onTranscript(text);
          }
        } catch (err) {
          console.error("Transcription error:", err);
        } finally {
          setState("idle");
          resolve();
        }
      };
      recorder.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
    });
  }, [cleanup, onTranscript]);

  const startRecording = useCallback(async () => {
    if (state !== "idle") return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Pick a supported MIME type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      // Set up Web Audio API for silence detection
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Float32Array(analyser.fftSize);
      startTimeRef.current = Date.now();
      const minRecordingMs = 1500; // minimum recording before silence can stop
      let speechDetected = false;
      let silentSince: number | null = null;

      const checkSilence = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataArray);

        // Compute RMS
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);

        const elapsed = Date.now() - startTimeRef.current;

        // Track whether we've heard actual speech
        if (rms >= silenceThreshold) {
          speechDetected = true;
          silentSince = null;
        }

        // Only auto-stop after speech was detected AND minimum time passed
        if (speechDetected && elapsed > minRecordingMs) {
          if (rms < silenceThreshold) {
            if (silentSince === null) {
              silentSince = Date.now();
            } else if (Date.now() - silentSince >= silenceDuration) {
              stopAndTranscribe();
              return;
            }
          }
        }

        rafRef.current = requestAnimationFrame(checkSilence);
      };

      recorder.start(250); // collect data every 250ms
      setState("recording");

      // Start silence detection
      rafRef.current = requestAnimationFrame(checkSilence);

      // Safety max duration
      maxTimerRef.current = setTimeout(() => {
        stopAndTranscribe();
      }, maxDuration);
    } catch (err) {
      console.error("Microphone access error:", err);
      setState("idle");
    }
  }, [state, silenceThreshold, silenceDuration, maxDuration, stopAndTranscribe]);

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      cleanup();
      recorder.onstop = null;
      recorder.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
      chunksRef.current = [];
    }
    setState("idle");
  }, [cleanup]);

  return { state, startRecording, cancelRecording };
}
