require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const {
  createVideoTask,
  createImageVideoTask,
  getVideoStatus,
  isImageDownloadError,
  VIDEO_CONFIG,
} = require('./agnes-video');

const { validateGeneratedVideo } = require('./video-quality');

const {
  buildPublicImageUrls,
  normalizeImageUrl,
  unsupportedUrlReason,
  getImageFromStore,
  MAX_IMAGE_BYTES,
} = require('./image-host');

/*
 * FIX: Prompt Ideas page pehle isliye kaam nahi kar raha tha
 * kyunki server.js me prompt router mount hi nahi tha —
 * /api/prompt/generate hamesha 404 "API endpoint not found"
 * deta tha. Ab mount hai (neeche app.use('/api/prompt', ...)).
 */
const { promptRouter, logPromptStartupState } = require('./prompt-routes');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const jobs = new Map();

/* 289 frames @ 24fps lambi video hai - 5 min aksar kam padta tha. */
const MAX_JOB_TIME =
  Number(process.env.JOB_TIMEOUT_MINUTES || 15) * 60 * 1000;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 5000);

const MAX_RETRIES = 2;

const JOB_TTL = 6 * 60 * 60 * 1000;

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

app.use(
  express.json({
    limit: '25mb',
  })
);

/* --------------------------------------------------
   HELPERS
-------------------------------------------------- */

function createJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function updateJob(jobId, changes) {
  const existing = jobs.get(jobId);

  if (!existing) return;

  jobs.set(jobId, {
    ...existing,
    ...changes,
    updatedAt: Date.now(),
  });
}

function clientJob(job) {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    progress: job.progress || 0,
    videoUrl: job.videoUrl || null,
    error: job.error || null,
    hint: job.hint || null,
    attempt: job.attempt || 1,
    maxAttempts: job.maxAttempts || MAX_RETRIES + 1,
    qualityMode: job.qualityMode || 'high',
    imageHost: job.imageHost || null,
  };
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL) jobs.delete(id);
  }
}

setInterval(cleanupJobs, 30 * 60 * 1000).unref();

function validatePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return 'Prompt zaroori hai.';
  }

  if (prompt.trim().length < 3) {
    return 'Prompt thoda detail me likhein (kam se kam 3 characters).';
  }

  return null;
}

function validateImageUrlInput(imageUrl) {
  if (!imageUrl) return null;

  if (typeof imageUrl !== 'string') return 'Image URL invalid hai.';

  const trimmed = imageUrl.trim();

  if (!/^https?:\/\//i.test(trimmed)) {
    return 'Image URL http:// ya https:// se shuru hona chahiye.';
  }

  const blocked = unsupportedUrlReason(trimmed);
  if (blocked) return blocked;

  return null;
}

function validateImageDataInput(imageData) {
  if (!imageData) return null;

  if (typeof imageData !== 'string') return 'Image data invalid hai.';

  if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(imageData)) {
    return 'Sirf PNG, JPG, JPEG aur WEBP images support hoti hain.';
  }

  const base64 = imageData.split(',')[1] || '';
  const size = Math.ceil((base64.length * 3) / 4);

  if (size > MAX_IMAGE_BYTES) {
    return 'Image bahut badi hai. Maximum 12 MB.';
  }

  return null;
}

/* --------------------------------------------------
   PROMPT IDEAS (Gemini)  <-- ye mount missing tha
-------------------------------------------------- */

app.use('/api/prompt', promptRouter);

/* --------------------------------------------------
   LOCALLY HOSTED REFERENCE IMAGES
   (PUBLIC_BASE_URL set ho to Agnes yahin se image leta hai)
-------------------------------------------------- */

app.get('/api/images/:id', (req, res) => {
  const entry = getImageFromStore(req.params.id);

  if (!entry) {
    return res.status(404).json({
      ok: false,
      error: 'Image not found or expired',
    });
  }

  res.setHeader('Content-Type', entry.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=21600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.buffer);
});

/* --------------------------------------------------
   HEALTH / CONFIG
-------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'AI Blender Video Maker',
    agnes: Boolean(process.env.AGNES_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    model: 'agnes-video-v2.0',
    imageInput: 'Upload, Ctrl+V paste or public URL',
    imageRelay: {
      publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
      imgbbConfigured: Boolean(process.env.IMGBB_API_KEY),
    },
    timeoutMinutes: MAX_JOB_TIME / 60000,
    video: VIDEO_CONFIG,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    model: 'agnes-video-v2.0',
    width: VIDEO_CONFIG.width,
    height: VIDEO_CONFIG.height,
    num_frames: VIDEO_CONFIG.num_frames,
    frame_rate: VIDEO_CONFIG.frame_rate,
    durationSeconds: VIDEO_CONFIG.num_frames / VIDEO_CONFIG.frame_rate,
    maxRetries: MAX_RETRIES,
  });
});

/* --------------------------------------------------
   TEXT -> VIDEO
-------------------------------------------------- */

app.post('/api/generate', (req, res) => {
  const { prompt, qualityMode = 'high' } = req.body || {};

  const promptError = validatePrompt(prompt);

  if (promptError) {
    return res.status(400).json({ ok: false, error: promptError });
  }

  const jobId = createJobId();

  jobs.set(jobId, {
    jobId,
    type: 'text',
    prompt: prompt.trim(),
    qualityMode,
    status: 'starting',
    progress: 0,
    videoUrl: null,
    error: null,
    attempt: 1,
    maxAttempts: MAX_RETRIES + 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  res.json({ ok: true, ...clientJob(jobs.get(jobId)) });

  generateTextJob(jobId).catch((error) => {
    console.error('Background text job error:', error);
    updateJob(jobId, { status: 'failed', error: error.message });
  });
});

/* --------------------------------------------------
   IMAGE -> VIDEO
-------------------------------------------------- */

app.post('/api/generate-image', (req, res) => {
  const { prompt, imageData, imageUrl, qualityMode = 'high' } = req.body || {};

  const promptError = validatePrompt(prompt);

  if (promptError) {
    return res.status(400).json({ ok: false, error: promptError });
  }

  if (!imageData && !imageUrl) {
    return res.status(400).json({
      ok: false,
      error:
        'Image upload karein / Ctrl+V se paste karein ya image URL daalein.',
    });
  }

  const dataError = validateImageDataInput(imageData);
  if (dataError) {
    return res.status(400).json({ ok: false, error: dataError });
  }

  const urlError = imageData ? null : validateImageUrlInput(imageUrl);
  if (urlError) {
    return res.status(400).json({ ok: false, error: urlError });
  }

  const jobId = createJobId();

  jobs.set(jobId, {
    jobId,
    type: 'image',
    prompt: prompt.trim(),
    imageData: imageData || null,
    imageUrl: imageUrl ? normalizeImageUrl(imageUrl) : null,
    qualityMode,
    status: 'starting',
    progress: 0,
    videoUrl: null,
    error: null,
    attempt: 1,
    maxAttempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  res.json({ ok: true, ...clientJob(jobs.get(jobId)) });

  generateImageJob(jobId).catch((error) => {
    console.error('Background image job error:', error);
    updateJob(jobId, { status: 'failed', error: error.message });
  });
});

/* --------------------------------------------------
   TEXT JOB
-------------------------------------------------- */

async function generateTextJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    updateJob(jobId, { status: 'optimizing_prompt', progress: 2 });

    const result = await createVideoTask({
      prompt: job.prompt,
      qualityMode: job.qualityMode,
      hasReferenceImage: false,
    });

    updateJob(jobId, {
      status: result.status || 'queued',
      progress: result.progress || 5,
      agnesVideoId: result.videoId,
      agnesTaskId: result.taskId,
      finalPrompt: result.finalPrompt,
      negativePrompt: result.negativePrompt,
    });

    await pollJob(jobId);
  } catch (error) {
    updateJob(jobId, { status: 'failed', error: error.message });
  }
}

/* --------------------------------------------------
   IMAGE JOB

   Asli fix yahan hai:
   - image ko khud download/normalise karke kai public
     hosts par daalte hain
   - Agnes agar ek URL download na kar paaye to agle
     host ke URL se dobara try karte hain
-------------------------------------------------- */

async function generateImageJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  let candidates = [];

  try {
    updateJob(jobId, { status: 'preparing_image', progress: 3 });

    const prepared = await buildPublicImageUrls({
      imageData: job.imageData,
      imageUrl: job.imageUrl,
    });

    candidates = prepared.candidates;

    prepared.notes.forEach((note) => console.log(`[${jobId}] image:`, note));

    updateJob(jobId, {
      status: 'optimizing_prompt',
      progress: 8,
      imageHost: candidates[0]?.host || null,
      resolvedImageUrl: candidates[0]?.url || null,
      /* base64 ab zaroorat nahi - memory free */
      imageData: null,
    });
  } catch (error) {
    updateJob(jobId, {
      status: 'failed',
      error: error.message,
      hint: 'Chhoti PNG/JPG image try karein, ya backend/.env me IMGBB_API_KEY daalein.',
    });
    return;
  }

  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    try {
      console.log(
        `[${jobId}] Agnes ko image bhej rahe hain (${candidate.host}): ${candidate.url}`
      );

      const result = await createImageVideoTask({
        prompt: job.prompt,
        imageUrl: candidate.url,
        qualityMode: job.qualityMode,
      });

      updateJob(jobId, {
        status: result.status || 'queued',
        progress: result.progress || 5,
        agnesVideoId: result.videoId,
        agnesTaskId: result.taskId,
        finalPrompt: result.finalPrompt,
        negativePrompt: result.negativePrompt,
        imageHost: candidate.host,
        resolvedImageUrl: candidate.url,
        error: null,
      });

      await pollJob(jobId);
      return;
    } catch (error) {
      lastError = error;

      console.error(`[${jobId}] ${candidate.host} se fail hua:`, error.message);

      const canRetryElsewhere =
        isImageDownloadError(error.message) && i < candidates.length - 1;

      if (!canRetryElsewhere) break;

      updateJob(jobId, {
        status: 'retrying_image_host',
        progress: 4,
        error: `${candidate.host} se image download nahi hui, doosra host try kar rahe hain...`,
      });
    }
  }

  const message = lastError?.message || 'Image-to-video request fail ho gayi.';

  updateJob(jobId, {
    status: 'failed',
    error: message,
    hint: isImageDownloadError(message)
      ? 'Agnes ka server is image URL tak nahi pahunch paaya. Image ko "Upload Image" se bhejein (Google Drive/Photos links kaam nahi karte), ya .env me IMGBB_API_KEY add karein.'
      : null,
  });
}

/* --------------------------------------------------
   POLL
-------------------------------------------------- */

async function pollJob(jobId) {
  const startTime = Date.now();

  let consecutiveErrors = 0;

  while (true) {
    const job = jobs.get(jobId);
    if (!job) return;

    if (Date.now() - startTime > MAX_JOB_TIME) {
      updateJob(jobId, {
        status: 'failed',
        error: `Video generation ${
          MAX_JOB_TIME / 60000
        } minute me complete nahi hui (timeout).`,
      });
      return;
    }

    if (!job.agnesVideoId) {
      updateJob(jobId, {
        status: 'failed',
        error: 'Agnes ne video_id return nahi kiya.',
      });
      return;
    }

    try {
      const result = await getVideoStatus(job.agnesVideoId);

      consecutiveErrors = 0;

      updateJob(jobId, {
        status: result.status,
        progress: result.progress || job.progress || 0,
        videoUrl: result.videoUrl || job.videoUrl || null,
        error: result.status === 'failed' ? result.error : null,
      });

      console.log(
        `[${jobId}]`,
        result.status,
        `${result.progress || 0}%`,
        result.rawStatus ? `(agnes: ${result.rawStatus})` : ''
      );

      if (result.status === 'completed') {
        const quality = await validateGeneratedVideo({
          videoUrl: result.videoUrl,
          expectedDuration: VIDEO_CONFIG.num_frames / VIDEO_CONFIG.frame_rate,
        });

        if (!quality.passed) {
          const current = jobs.get(jobId);

          if (current.type === 'text' && current.attempt < MAX_RETRIES + 1) {
            updateJob(jobId, {
              status: 'retrying',
              progress: 0,
              attempt: current.attempt + 1,
              error: quality.reason,
            });

            const retry = await createVideoTask({
              prompt: `${current.prompt}

CORRECTION PASS:
Make the motion simpler and more physically coherent.
Prioritize stable geometry, identity, object continuity,
natural motion and frame-to-frame consistency.`,
              qualityMode: current.qualityMode,
              hasReferenceImage: false,
            });

            updateJob(jobId, {
              status: retry.status || 'queued',
              progress: retry.progress || 5,
              agnesVideoId: retry.videoId,
              agnesTaskId: retry.taskId,
            });

            continue;
          }

          updateJob(jobId, { status: 'failed', error: quality.reason });
          return;
        }

        updateJob(jobId, {
          status: 'completed',
          progress: 100,
          videoUrl: result.videoUrl,
          error: null,
        });

        return;
      }

      if (result.status === 'failed') {
        updateJob(jobId, {
          status: 'failed',
          error: result.error || 'Agnes video generation fail ho gaya.',
        });
        return;
      }
    } catch (error) {
      consecutiveErrors += 1;

      console.error(`[${jobId}] polling error:`, error.message);

      /* Lagatar 10 baar fail = network/key problem, rukna behtar hai. */
      if (consecutiveErrors >= 10) {
        updateJob(jobId, {
          status: 'failed',
          error: `Agnes status check baar baar fail hua: ${error.message}`,
        });
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/* --------------------------------------------------
   STATUS
-------------------------------------------------- */

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job not found' });
  }

  res.json({ ok: true, ...clientJob(job) });
});

/* --------------------------------------------------
   OPTIONAL: built frontend serve karo (npm run build ke baad)
-------------------------------------------------- */

const FRONTEND_DIST = path.join(
  __dirname,
  '..',
  'frontend',
  'dist',
  'frontend',
  'browser'
);

app.use(express.static(FRONTEND_DIST));

/* --------------------------------------------------
   404
-------------------------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: `API endpoint not found: ${req.method} ${req.path}`,
    });
  }

  res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (error) => {
    if (error) res.status(404).json({ ok: false, error: 'Not found' });
  });
});

/* --------------------------------------------------
   ERROR HANDLER
-------------------------------------------------- */

app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Image/request bahut bada hai. 12 MB se chhoti image use karein.',
    });
  }

  res.status(500).json({
    ok: false,
    error: error.message || 'Internal server error',
  });
});

/* --------------------------------------------------
   START
-------------------------------------------------- */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('======================================');
    console.log(' AI Blender Video Maker');
    console.log('======================================');
    console.log(`Server:       http://localhost:${PORT}`);
    console.log('Model:        agnes-video-v2.0');
    console.log(
      'Resolution:  ',
      `${VIDEO_CONFIG.width}x${VIDEO_CONFIG.height}`
    );
    console.log('Frames:      ', VIDEO_CONFIG.num_frames);
    console.log('FPS:         ', VIDEO_CONFIG.frame_rate);
    console.log(
      'Duration:    ',
      (VIDEO_CONFIG.num_frames / VIDEO_CONFIG.frame_rate).toFixed(2),
      'seconds'
    );
    console.log('Timeout:     ', MAX_JOB_TIME / 60000, 'minutes');
    console.log('Image input:  UPLOAD / CTRL+V / URL');
    console.log(
      'Image relay: ',
      process.env.PUBLIC_BASE_URL
        ? `self-hosted (${process.env.PUBLIC_BASE_URL})`
        : process.env.IMGBB_API_KEY
          ? 'imgbb + catbox + 0x0 + tmpfiles'
          : 'catbox + 0x0 + tmpfiles'
    );
    console.log('Prompt Ideas: /api/prompt/* mounted');

    if (!process.env.AGNES_API_KEY) {
      console.warn(
        '⚠️  AGNES_API_KEY missing — video generation kaam nahi karega.'
      );
    }

    logPromptStartupState();

    console.log('======================================');
    console.log('');
  });
}

module.exports = app;
