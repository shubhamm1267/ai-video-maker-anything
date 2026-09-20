import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { VIDEO_API_BASE } from '../shared/api.config';

export type QualityMode =
  | 'standard'
  | 'high';

export type GenerationStatus =
  | 'starting'
  | 'preparing_image'
  | 'retrying_image_host'
  | 'optimizing_prompt'
  | 'queued'
  | 'in_progress'
  | 'retrying'
  | 'completed'
  | 'failed'
  | string;

export interface GenerationJob {
  jobId: string;

  type?: 'text' | 'image';

  status: GenerationStatus;

  progress: number;

  videoUrl: string | null;

  error: string | null;

  hint?: string | null;

  imageHost?: string | null;

  attempt: number;

  maxAttempts: number;

  qualityMode: QualityMode | string;
}

@Injectable({
  providedIn: 'root',
})
export class GenerationService {
  private readonly apiBase =
    VIDEO_API_BASE;

  constructor(
    private http: HttpClient
  ) {}

  submitGeneration(
    prompt: string,
    qualityMode: QualityMode
  ): Observable<GenerationJob> {
    return this.http.post<GenerationJob>(
      `${this.apiBase}/generate`,
      {
        prompt,
        qualityMode,
      }
    );
  }

  submitImageGeneration(
    prompt: string,
    imageData: string | null,
    imageUrl: string,
    qualityMode: QualityMode
  ): Observable<GenerationJob> {
    return this.http.post<GenerationJob>(
      `${this.apiBase}/generate-image`,
      {
        prompt,
        imageData,
        imageUrl:
          imageUrl.trim() ||
          null,
        qualityMode,
      }
    );
  }

  pollStatus(
    jobId: string
  ): Observable<GenerationJob> {
    return this.http.get<GenerationJob>(
      `${this.apiBase}/status/${jobId}`
    );
  }
}