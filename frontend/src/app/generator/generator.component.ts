import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { Subscription, timer } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';

import {
  GenerationJob,
  GenerationService,
  QualityMode,
} from './generation.service';

import { PromptBridgeService } from '../shared/prompt-bridge.service';

@Component({
  selector: 'app-generator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './generator.component.html',
  styleUrl: './generator.component.scss',
})
export class GeneratorComponent implements OnInit, OnDestroy {
  mode: 'text' | 'image' = 'text';

  prompt = '';

  imageUrl = '';

  imageData: string | null = null;

  imagePreview: string | null = null;

  imageFileName = '';

  qualityMode: QualityMode = 'high';

  job: GenerationJob | null = null;

  loading = false;

  errorMessage = '';

  errorHint = '';

  /** Share links (Drive/Dropbox) ke liye chhota sa warning. */
  urlWarning = '';

  private pollSubscription: Subscription | null = null;

  private objectUrl: string | null = null;

  constructor(
    private generationService: GenerationService,
    private bridge: PromptBridgeService
  ) {}

  /*
   * FIX: "Prompt Ideas -> Use for video" kaam nahi karta tha,
   * kyunki yahan bridge.take() kabhi call hi nahi hota tha.
   */
  ngOnInit(): void {
    const pending = this.bridge.take();

    if (pending) {
      this.prompt = pending;
    }
  }

  selectMode(mode: 'text' | 'image') {
    this.mode = mode;
    this.resetError();

    if (mode === 'text') {
      this.clearImage();
      this.imageUrl = '';
      this.urlWarning = '';
    }
  }

  onImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    this.useImageFile(file);

    input.value = '';
  }

  /* Ctrl + V image support */
  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    if (this.mode !== 'image') return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();

        if (file) {
          event.preventDefault();
          this.useImageFile(file);
          return;
        }
      }
    }
  }

  private useImageFile(file: File) {
    const allowedTypes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];

    if (!allowedTypes.includes(file.type)) {
      this.errorMessage =
        'Sirf PNG, JPG, JPEG aur WEBP images support hoti hain.';
      return;
    }

    const maxSize = 12 * 1024 * 1024;

    if (file.size > maxSize) {
      this.errorMessage = 'Image 12 MB se chhoti honi chahiye.';
      return;
    }

    this.resetError();

    this.imageFileName = file.name;

    /* Upload ki hui image, URL se zyada priority rakhti hai. */
    this.imageUrl = '';
    this.urlWarning = '';

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }

    this.objectUrl = URL.createObjectURL(file);
    this.imagePreview = this.objectUrl;

    const reader = new FileReader();

    reader.onload = () => {
      this.imageData = reader.result as string;
    };

    reader.onerror = () => {
      this.imageData = null;
      this.errorMessage = 'Selected image padhi nahi ja saki.';
    };

    reader.readAsDataURL(file);
  }

  /**
   * URL type karte hi user ko bata do ki ye link chalega ya nahi.
   * (Google Drive/Photos wale links hi sabse zyada fail hote the.)
   */
  onImageUrlChange() {
    this.urlWarning = '';

    const url = this.imageUrl.trim();
    if (!url) return;

    if (!/^https?:\/\//i.test(url)) {
      this.urlWarning = 'URL http:// ya https:// se shuru hona chahiye.';
      return;
    }

    if (/photos\.app\.goo\.gl|photos\.google\.com/i.test(url)) {
      this.urlWarning =
        'Google Photos links se image download nahi hoti. Image download karke "Upload Image" use karein.';
      return;
    }

    if (/drive\.google\.com/i.test(url)) {
      this.urlWarning =
        'Google Drive link ko server direct-download link me badal dega, par file ka access "Anyone with the link" hona zaroori hai. Upload karna zyada safe hai.';
      return;
    }

    if (/\/\/(?:www\.)?(?:instagram|facebook|pinterest)\.com/i.test(url)) {
      this.urlWarning =
        'Social media page links image file nahi hote. Image par right-click -> "Copy image address" karein.';
    }
  }

  removeImage() {
    this.clearImage();
  }

  clearImage() {
    this.imageData = null;
    this.imagePreview = null;
    this.imageFileName = '';

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  get hasImageSource(): boolean {
    return Boolean(this.imageData || this.imageUrl.trim());
  }

  /** Status ko padhne layak text me badalta hai. */
  get statusLabel(): string {
    const status = this.job?.status || '';

    const labels: Record<string, string> = {
      starting: 'Shuru ho raha hai…',
      preparing_image: 'Image tayaar aur upload ho rahi hai…',
      retrying_image_host: 'Doosre image host se try kar rahe hain…',
      optimizing_prompt: 'Prompt optimise ho raha hai…',
      queued: 'Queue me hai…',
      in_progress: 'Video ban rahi hai…',
      retrying: 'Quality retry chal raha hai…',
      completed: 'Video ready hai',
      failed: 'Fail ho gaya',
    };

    return labels[status] || status;
  }

  generate() {
    this.resetError();

    const cleanPrompt = this.prompt.trim();

    if (!cleanPrompt) {
      this.errorMessage = 'Pehle prompt likhein.';
      return;
    }

    if (this.mode === 'image' && !this.hasImageSource) {
      this.errorMessage =
        'Image upload/paste karein ya image URL daalein.';
      return;
    }

    this.loading = true;
    this.job = null;

    if (this.mode === 'text') {
      this.generateText(cleanPrompt);
    } else {
      this.generateImage(cleanPrompt);
    }
  }

  private generateText(prompt: string) {
    this.generationService
      .submitGeneration(prompt, this.qualityMode)
      .subscribe({
        next: (job) => {
          this.job = job;
          this.startPolling(job.jobId);
        },
        error: (error) => this.handleError(error),
      });
  }

  private generateImage(prompt: string) {
    const data = this.imageData;
    const url = data ? '' : this.imageUrl.trim();

    this.generationService
      .submitImageGeneration(prompt, data, url, this.qualityMode)
      .subscribe({
        next: (job) => {
          this.job = job;
          this.startPolling(job.jobId);
        },
        error: (error) => this.handleError(error),
      });
  }

  private startPolling(jobId: string) {
    this.pollSubscription?.unsubscribe();

    /* timer(1500, 3000): pehla status 1.5s me hi mil jaata hai. */
    this.pollSubscription = timer(1500, 3000)
      .pipe(
        switchMap(() => this.generationService.pollStatus(jobId)),
        takeWhile(
          (job) => job.status !== 'completed' && job.status !== 'failed',
          true
        )
      )
      .subscribe({
        next: (job) => {
          this.job = job;

          if (job.status === 'completed' || job.status === 'failed') {
            this.loading = false;

            if (job.status === 'failed') {
              this.errorMessage = job.error || 'Video generation fail ho gaya.';
              this.errorHint = job.hint || '';
            }
          }
        },
        error: (error) => this.handleError(error),
      });
  }

  private handleError(error: any) {
    this.loading = false;
    this.pollSubscription?.unsubscribe();

    if (error?.status === 0) {
      this.errorMessage =
        'Backend tak pahunch nahi paaye. Kya backend server chal raha hai?';
      this.errorHint = 'start.bat / npm run dev se dono servers chalte hain.';
      return;
    }

    this.errorMessage =
      error?.error?.error || error?.message || 'Kuch galat ho gaya.';

    this.errorHint = error?.error?.hint || '';

    console.error(error);
  }

  resetError() {
    this.errorMessage = '';
    this.errorHint = '';
  }

  ngOnDestroy() {
    this.pollSubscription?.unsubscribe();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
  }
}
