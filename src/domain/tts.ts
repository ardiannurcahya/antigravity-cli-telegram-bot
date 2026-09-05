export interface SynthesisResult {
  audioPath: string;
  format: "ogg" | "mp3";
  durationSeconds?: number;
}

export interface TtsService {
  synthesize(text: string, options?: { voice?: string; signal?: AbortSignal }): Promise<SynthesisResult>;
  isAvailable(): boolean;
}
