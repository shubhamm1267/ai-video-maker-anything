import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
} from '@angular/core';

import {
  CommonModule,
} from '@angular/common';

import {
  FormsModule,
} from '@angular/forms';

import {
  Subscription,
  timer,
} from 'rxjs';

import {
  switchMap,
  takeWhile,
} from 'rxjs/operators';

import {
  AgnesVideoModel,
  AspectRatio,
  GenerationJob,
  GenerationService,
  QualityMode,
  VideoDuration,
  VideoResolution,
} from './generation.service';

import {
  PromptBridgeService,
} from '../shared/prompt-bridge.service';

@Component({
  selector:
    'app-generator',

  standalone:
    true,

  imports: [
    CommonModule,
    FormsModule,
  ],

  templateUrl:
    './generator.component.html',

  styleUrl:
    './generator.component.scss',
})
export class GeneratorComponent
  implements OnInit, OnDestroy
{
  mode:
    | 'text'
    | 'image' =
    'text';

  prompt =
    '';

  imageUrl =
    '';

  imageData:
    string | null =
    null;

  imagePreview:
    string | null =
    null;

  imageFileName =
    '';

  qualityMode:
    QualityMode =
    'high';

  aspectRatio:
    AspectRatio =
    '9:16';

  /*
   * Default model:
   * Video 2.0 because it supports our
   * current 18-second setup.
   */
  videoModel:
    AgnesVideoModel =
    'agnes-video-v2.0';

  durationSeconds:
    VideoDuration =
    12;

  resolution:
    VideoResolution =
    '720P';

  job:
    GenerationJob | null =
    null;

  loading =
    false;

  errorMessage =
    '';

  errorHint =
    '';

  urlWarning =
    '';

  private pollSubscription:
    Subscription | null =
    null;

  private objectUrl:
    string | null =
    null;

  constructor(
    private generationService:
      GenerationService,

    private bridge:
      PromptBridgeService
  ) {}

  ngOnInit():
    void {
    const pending =
      this.bridge.take();

    if (pending) {
      this.prompt =
        pending;
    }
  }

  /*
   * =======================================================
   * MODEL
   * =======================================================
   */

  selectVideoModel(
    model:
      AgnesVideoModel
  ) {
    if (
      this.loading
    ) {
      return;
    }

    this.videoModel =
      model;

    /*
     * Video 2.0:
     * only 12 / 18.
     */
    if (
      model ===
      'agnes-video-v2.0'
    ) {
      if (
        this.durationSeconds !==
          12 &&
        this.durationSeconds !==
          18
      ) {
        this.durationSeconds =
          12;
      }

      this.resolution =
        '720P';

      return;
    }

    /*
     * 2.5 / Flash:
     * max 12 seconds.
     */
    if (
      this.durationSeconds ===
      18
    ) {
      this.durationSeconds =
        12;
    }

    /*
     * Flash = 720P only.
     */
    if (
      model ===
      'agnes-video-2.5-flash'
    ) {
      this.resolution =
        '720P';
    }
  }

  get durationOptions():
    VideoDuration[] {
    if (
      this.videoModel ===
      'agnes-video-v2.0'
    ) {
      return [
        12,
        18,
      ];
    }

    return [
      4,
      6,
      8,
      10,
      12,
    ];
  }

  get resolutionOptions():
    VideoResolution[] {
    if (
      this.videoModel ===
      'agnes-video-2.5'
    ) {
      return [
        '720P',
        '1080P',
        '1K',
        '2K',
      ];
    }

    return [
      '720P',
    ];
  }

  get isVideo20():
    boolean {
    return (
      this.videoModel ===
      'agnes-video-v2.0'
    );
  }

  get isVideo25():
    boolean {
    return (
      this.videoModel ===
      'agnes-video-2.5'
    );
  }

  get isVideo25Flash():
    boolean {
    return (
      this.videoModel ===
      'agnes-video-2.5-flash'
    );
  }

  get selectedModelLabel():
    string {
    switch (
      this.videoModel
    ) {
      case 'agnes-video-2.5':
        return 'Agnes Video 2.5';

      case 'agnes-video-2.5-flash':
        return 'Agnes Video 2.5 Flash';

      default:
        return 'Agnes Video 2.0';
    }
  }

  /*
   * =======================================================
   * MODE
   * =======================================================
   */

  selectMode(
    mode:
      | 'text'
      | 'image'
  ) {
    this.mode =
      mode;

    this.resetError();

    if (
      mode ===
      'text'
    ) {
      this.clearImage();

      this.imageUrl =
        '';

      this.urlWarning =
        '';
    }
  }

  /*
   * =======================================================
   * IMAGE
   * =======================================================
   */

  onImageSelected(
    event:
      Event
  ) {
    const input =
      event.target as HTMLInputElement;

    const file =
      input.files?.[0];

    if (!file) {
      return;
    }

    this.useImageFile(
      file
    );

    input.value =
      '';
  }

  @HostListener(
    'document:paste',
    ['$event']
  )
  onPaste(
    event:
      ClipboardEvent
  ) {
    if (
      this.mode !==
      'image'
    ) {
      return;
    }

    const items =
      event.clipboardData
        ?.items;

    if (!items) {
      return;
    }

    for (
      let i = 0;
      i <
      items.length;
      i++
    ) {
      const item =
        items[i];

      if (
        item.kind ===
          'file' &&
        item.type.startsWith(
          'image/'
        )
      ) {
        const file =
          item.getAsFile();

        if (file) {
          event.preventDefault();

          this.useImageFile(
            file
          );

          return;
        }
      }
    }
  }

  private useImageFile(
    file:
      File
  ) {
    const allowedTypes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];

    if (
      !allowedTypes.includes(
        file.type
      )
    ) {
      this.errorMessage =
        'Sirf PNG, JPG, JPEG aur WEBP images support hoti hain.';

      return;
    }

    const maxSize =
      12 *
      1024 *
      1024;

    if (
      file.size >
      maxSize
    ) {
      this.errorMessage =
        'Image 12 MB se chhoti honi chahiye.';

      return;
    }

    this.resetError();

    this.imageFileName =
      file.name;

    this.imageUrl =
      '';

    this.urlWarning =
      '';

    if (
      this.objectUrl
    ) {
      URL.revokeObjectURL(
        this.objectUrl
      );
    }

    this.objectUrl =
      URL.createObjectURL(
        file
      );

    this.imagePreview =
      this.objectUrl;

    const reader =
      new FileReader();

    reader.onload =
      () => {
        this.imageData =
          reader.result as string;
      };

    reader.onerror =
      () => {
        this.imageData =
          null;

        this.errorMessage =
          'Selected image padhi nahi ja saki.';
      };

    reader.readAsDataURL(
      file
    );
  }

  onImageUrlChange() {
    this.urlWarning =
      '';

    const url =
      this.imageUrl.trim();

    if (!url) {
      return;
    }

    if (
      !/^https?:\/\//i.test(
        url
      )
    ) {
      this.urlWarning =
        'URL http:// ya https:// se shuru hona chahiye.';

      return;
    }

    if (
      /photos\.app\.goo\.gl|photos\.google\.com/i.test(
        url
      )
    ) {
      this.urlWarning =
        'Google Photos link use na karein. Image upload karein.';

      return;
    }

    if (
      /drive\.google\.com/i.test(
        url
      )
    ) {
      this.urlWarning =
        'Google Drive file Anyone with the link honi chahiye.';
    }
  }

  removeImage() {
    this.clearImage();
  }

  clearImage() {
    this.imageData =
      null;

    this.imagePreview =
      null;

    this.imageFileName =
      '';

    if (
      this.objectUrl
    ) {
      URL.revokeObjectURL(
        this.objectUrl
      );

      this.objectUrl =
        null;
    }
  }

  get hasImageSource():
    boolean {
    return Boolean(
      this.imageData ||
        this.imageUrl.trim()
    );
  }

  /*
   * =======================================================
   * STATUS
   * =======================================================
   */

  get statusLabel():
    string {
    const status =
      this.job?.status ||
      '';

    const labels:
      Record<
        string,
        string
      > = {
      starting:
        'Shuru ho raha hai…',

      preparing_image:
        'Image tayaar ho rahi hai…',

      retrying_image_host:
        'Doosra image host try ho raha hai…',

      optimizing_prompt:
        'Prompt optimise ho raha hai…',

      queued:
        'Agnes queue me hai…',

      in_progress:
        'Video generate ho rahi hai…',

      retrying:
        'Quality retry chal raha hai…',

      completed:
        'Video ready hai',

      failed:
        'Generation fail hui',
    };

    return (
      labels[status] ||
      status
    );
  }

  /*
   * =======================================================
   * GENERATE
   * =======================================================
   */

  generate() {
    this.resetError();

    const cleanPrompt =
      this.prompt.trim();

    if (!cleanPrompt) {
      this.errorMessage =
        'Pehle prompt likhein.';

      return;
    }

    if (
      this.mode ===
        'image' &&
      !this.hasImageSource
    ) {
      this.errorMessage =
        'Image upload/paste karein ya image URL daalein.';

      return;
    }

    /*
     * Safety:
     * Flash always 720P.
     */
    if (
      this.isVideo25Flash
    ) {
      this.resolution =
        '720P';
    }

    this.loading =
      true;

    this.job =
      null;

    if (
      this.mode ===
      'text'
    ) {
      this.generateText(
        cleanPrompt
      );
    } else {
      this.generateImage(
        cleanPrompt
      );
    }
  }

  private generateText(
    prompt:
      string
  ) {
    this.generationService
      .submitGeneration(
        prompt,

        this.qualityMode,

        this.aspectRatio,

        this.durationSeconds,

        this.videoModel,

        this.resolution
      )
      .subscribe({
        next:
          (job) => {
            this.job =
              job;

            this.startPolling(
              job.jobId
            );
          },

        error:
          (error) =>
            this.handleError(
              error
            ),
      });
  }

  private generateImage(
    prompt:
      string
  ) {
    const data =
      this.imageData;

    const url =
      data
        ? ''
        : this.imageUrl.trim();

    this.generationService
      .submitImageGeneration(
        prompt,

        data,

        url,

        this.qualityMode,

        this.aspectRatio,

        this.durationSeconds,

        this.videoModel,

        this.resolution
      )
      .subscribe({
        next:
          (job) => {
            this.job =
              job;

            this.startPolling(
              job.jobId
            );
          },

        error:
          (error) =>
            this.handleError(
              error
            ),
      });
  }

  private startPolling(
    jobId:
      string
  ) {
    this.pollSubscription
      ?.unsubscribe();

    this.pollSubscription =
      timer(
        1500,
        3000
      )
        .pipe(
          switchMap(
            () =>
              this.generationService
                .pollStatus(
                  jobId
                )
          ),

          takeWhile(
            (job) =>
              job.status !==
                'completed' &&
              job.status !==
                'failed',

            true
          )
        )
        .subscribe({
          next:
            (job) => {
              this.job =
                job;

              if (
                job.status ===
                  'completed' ||
                job.status ===
                  'failed'
              ) {
                this.loading =
                  false;

                if (
                  job.status ===
                  'failed'
                ) {
                  this.errorMessage =
                    job.error ||
                    'Video generation fail ho gaya.';

                  this.errorHint =
                    job.hint ||
                    '';
                }
              }
            },

          error:
            (error) =>
              this.handleError(
                error
              ),
        });
  }

  private handleError(
    error:
      any
  ) {
    this.loading =
      false;

    this.pollSubscription
      ?.unsubscribe();

    if (
      error?.status ===
      0
    ) {
      this.errorMessage =
        'Backend tak pahunch nahi paaye.';

      this.errorHint =
        'Backend server check karein.';

      return;
    }

    this.errorMessage =
      error?.error?.error ||
      error?.message ||
      'Kuch galat ho gaya.';

    this.errorHint =
      error?.error?.hint ||
      '';

    console.error(
      error
    );
  }

  resetError() {
    this.errorMessage =
      '';

    this.errorHint =
      '';
  }

  ngOnDestroy() {
    this.pollSubscription
      ?.unsubscribe();

    if (
      this.objectUrl
    ) {
      URL.revokeObjectURL(
        this.objectUrl
      );
    }
  }
}