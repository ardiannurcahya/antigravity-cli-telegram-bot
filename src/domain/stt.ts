export interface TranscriptionResult {
  text: string;
  detectedLanguage?: string;
  durationSeconds?: number;
  confidence?: number;
}

export interface SttService {
  transcribe(audioFilePath: string, options?: { language?: string; signal?: AbortSignal }): Promise<TranscriptionResult>;
  isAvailable(): boolean;
}
