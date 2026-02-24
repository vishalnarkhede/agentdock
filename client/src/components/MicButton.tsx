import { useVoiceInput, type VoiceState } from "../hooks/useVoiceInput";

interface Props {
  onTranscript: (text: string) => void;
}

const labels: Record<VoiceState, string> = {
  idle: "mic",
  recording: "rec",
  transcribing: "...",
};

export function MicButton({ onTranscript }: Props) {
  const { state, startRecording, cancelRecording } = useVoiceInput({
    onTranscript,
  });

  const handleClick = () => {
    if (state === "idle") startRecording();
    else if (state === "recording") cancelRecording();
  };

  return (
    <button
      className={`btn-mic ${state}`}
      onClick={handleClick}
      disabled={state === "transcribing"}
      title={
        state === "idle"
          ? "Start voice input"
          : state === "recording"
            ? "Cancel recording"
            : "Transcribing..."
      }
    >
      {labels[state]}
    </button>
  );
}
