import {
  Injectable,
} from '@angular/core';

import {
  HttpClient,
} from '@angular/common/http';

import {
  Observable,
} from 'rxjs';

import {
  VIDEO_API_BASE,
} from '../shared/api.config';

export type QualityMode =
  | 'standard'
  | 'high';

export type AspectRatio =
  | '9:16'
  | '16:9';

export type AgnesVideoModel =
  | 'agnes-video-v2.0'
  | 'agnes-video-2.5'
  | 'agnes-video-2.5-flash';

export type VideoResolution =
  | '720P'
  | '1080P'
  | '1K'
  | '2K';

export type VideoDuration =
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 18;

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
  jobId:
    string;

  type?:
    | 'text'
    | 'image';

  status:
    GenerationStatus;

  progress:
    number;

  videoUrl:
    string | null;

  error:
    string | null;

  hint?:
    string | null;

  imageHost?:
    string | null;

  attempt:
    number;

  maxAttempts:
    number;

  qualityMode:
    QualityMode | string;

  aspectRatio?:
    AspectRatio | string;

  durationSeconds?:
    VideoDuration | number;

  videoModel?:
    AgnesVideoModel | string;

  resolution?:
    VideoResolution | string;

  frameRate?:
    number | null;
}

@Injectable({
  providedIn:
    'root',
})
export class GenerationService {
  private readonly apiBase =
    VIDEO_API_BASE;

  constructor(
    private http:
      HttpClient
  ) {}

  submitGeneration(
    prompt:
      string,

    qualityMode:
      QualityMode,

    aspectRatio:
      AspectRatio,

    durationSeconds:
      VideoDuration,

    videoModel:
      AgnesVideoModel,

    resolution:
      VideoResolution
  ): Observable<GenerationJob> {
    return this.http.post<GenerationJob>(
      `${this.apiBase}/generate`,

      {
        prompt,

        qualityMode,

        aspectRatio,

        durationSeconds,

        videoModel,

        resolution,
      }
    );
  }

  submitImageGeneration(
    prompt:
      string,

    imageData:
      string | null,

    imageUrl:
      string,

    qualityMode:
      QualityMode,

    aspectRatio:
      AspectRatio,

    durationSeconds:
      VideoDuration,

    videoModel:
      AgnesVideoModel,

    resolution:
      VideoResolution
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

        aspectRatio,

        durationSeconds,

        videoModel,

        resolution,
      }
    );
  }

  pollStatus(
    jobId:
      string
  ): Observable<GenerationJob> {
    return this.http.get<GenerationJob>(
      `${this.apiBase}/status/${jobId}`
    );
  }
}