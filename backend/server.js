require('dotenv').config();

const path =
  require('path');

const express =
  require('express');

const cors =
  require('cors');

const {
  createVideoTask,
  createImageVideoTask,
  getVideoStatus,
  isImageDownloadError,
  VIDEO_CONFIG,
  VIDEO_MODELS,
  getModelConfig,
  isLegacyModel,
  getReferenceImageDimensions,
  getLegacyDurationConfig,
} = require('./agnes-video');

const {
  validateGeneratedVideo,
} = require('./video-quality');

const {
  buildPublicImageUrls,
  normalizeImageUrl,
  unsupportedUrlReason,
  getImageFromStore,
  MAX_IMAGE_BYTES,
} = require('./image-host');

const {
  promptRouter,
  logPromptStartupState,
} = require('./prompt-routes');

const app =
  express();

const PORT =
  Number(
    process.env.PORT ||
      3000
  );

const jobs =
  new Map();

const MAX_JOB_TIME =
  Number(
    process.env
      .JOB_TIMEOUT_MINUTES ||
      20
  ) *
  60 *
  1000;

const POLL_INTERVAL =
  Number(
    process.env
      .POLL_INTERVAL_MS ||
      5000
  );

const MAX_RETRIES =
  2;

const JOB_TTL =
  6 *
  60 *
  60 *
  1000;

app.use(
  cors({
    origin:
      true,

    credentials:
      false,
  })
);

app.use(
  express.json({
    limit:
      '25mb',
  })
);

/* =========================================================
   HELPERS
========================================================= */

function createJobId() {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function updateJob(
  jobId,
  changes
) {
  const existing =
    jobs.get(
      jobId
    );

  if (!existing) {
    return;
  }

  jobs.set(
    jobId,

    {
      ...existing,

      ...changes,

      updatedAt:
        Date.now(),
    }
  );
}

function clientJob(
  job
) {
  return {
    jobId:
      job.jobId,

    type:
      job.type,

    status:
      job.status,

    progress:
      job.progress ||
      0,

    videoUrl:
      job.videoUrl ||
      null,

    error:
      job.error ||
      null,

    hint:
      job.hint ||
      null,

    attempt:
      job.attempt ||
      1,

    maxAttempts:
      job.maxAttempts ||
      MAX_RETRIES +
        1,

    qualityMode:
      job.qualityMode ||
      'high',

    aspectRatio:
      job.aspectRatio ||
      VIDEO_CONFIG
        .defaultAspectRatio,

    durationSeconds:
      job.durationSeconds ||
      VIDEO_CONFIG
        .defaultDurationSeconds,

    videoModel:
      job.videoModel ||
      VIDEO_CONFIG
        .defaultModel,

    resolution:
      job.resolution ||
      VIDEO_CONFIG
        .defaultResolution,

    frameRate:
      isLegacyModel(
        job.videoModel
      )
        ? VIDEO_CONFIG
            .frame_rate
        : null,

    imageHost:
      job.imageHost ||
      null,
  };
}

function cleanupJobs() {
  const now =
    Date.now();

  for (
    const [
      id,
      job,
    ] of jobs
  ) {
    if (
      now -
        job.updatedAt >
      JOB_TTL
    ) {
      jobs.delete(
        id
      );
    }
  }
}

setInterval(
  cleanupJobs,
  30 * 60 * 1000
).unref();

/* =========================================================
   VALIDATION
========================================================= */

function validatePrompt(
  prompt
) {
  if (
    !prompt ||
    typeof prompt !==
      'string' ||
    !prompt.trim()
  ) {
    return 'Prompt zaroori hai.';
  }

  if (
    prompt.trim().length <
    3
  ) {
    return 'Prompt thoda detail me likhein.';
  }

  return null;
}

function validateAspectRatio(
  aspectRatio
) {
  if (
    ![
      '9:16',
      '16:9',
    ].includes(
      aspectRatio
    )
  ) {
    return 'Video format invalid hai. Sirf 9:16 ya 16:9 select karein.';
  }

  return null;
}

function validateVideoModel(
  videoModel
) {
  if (
    !VIDEO_MODELS[
      videoModel
    ]
  ) {
    return 'Invalid Agnes video model.';
  }

  return null;
}

function validateDuration(
  videoModel,
  durationSeconds
) {
  const model =
    getModelConfig(
      videoModel
    );

  const duration =
    Number(
      durationSeconds
    );

  if (
    !Number.isFinite(
      duration
    )
  ) {
    return 'Video duration invalid hai.';
  }

  if (
    !model.allowedDurations.includes(
      duration
    )
  ) {
    if (
      videoModel ===
      'agnes-video-v2.0'
    ) {
      return 'Video 2.0 me 12 sec ya 18 sec select karein.';
    }

    return 'Video 2.5 models 4 se 12 seconds tak support karte hain.';
  }

  return null;
}

function validateResolution(
  videoModel,
  resolution
) {
  const model =
    getModelConfig(
      videoModel
    );

  if (
    !model.allowedResolutions.includes(
      resolution
    )
  ) {
    if (
      videoModel ===
      'agnes-video-2.5-flash'
    ) {
      return 'Video 2.5 Flash sirf 720P support karta hai.';
    }

    return 'Selected resolution is not supported by this Agnes model.';
  }

  return null;
}

function validateImageUrlInput(
  imageUrl
) {
  if (!imageUrl) {
    return null;
  }

  if (
    typeof imageUrl !==
    'string'
  ) {
    return 'Image URL invalid hai.';
  }

  const trimmed =
    imageUrl.trim();

  if (
    !/^https?:\/\//i.test(
      trimmed
    )
  ) {
    return 'Image URL http:// ya https:// se shuru hona chahiye.';
  }

  const blocked =
    unsupportedUrlReason(
      trimmed
    );

  if (blocked) {
    return blocked;
  }

  return null;
}

function validateImageDataInput(
  imageData
) {
  if (!imageData) {
    return null;
  }

  if (
    typeof imageData !==
    'string'
  ) {
    return 'Image data invalid hai.';
  }

  if (
    !/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(
      imageData
    )
  ) {
    return 'Sirf PNG, JPG, JPEG aur WEBP images support hoti hain.';
  }

  const base64 =
    imageData.split(
      ','
    )[1] || '';

  const size =
    Math.ceil(
      (base64.length *
        3) /
        4
    );

  if (
    size >
    MAX_IMAGE_BYTES
  ) {
    return 'Image bahut badi hai. Maximum 12 MB.';
  }

  return null;
}

function validateGenerationSettings(
  body
) {
  const videoModel =
    body.videoModel ||
    VIDEO_CONFIG
      .defaultModel;

  const aspectRatio =
    body.aspectRatio ||
    VIDEO_CONFIG
      .defaultAspectRatio;

  const durationSeconds =
    Number(
      body.durationSeconds ??
        VIDEO_CONFIG
          .defaultDurationSeconds
    );

  /*
   * Video 2.0 me resolution API parameter nahi hai.
   * 720P value sirf frontend compatibility ke liye.
   */
  let resolution =
    body.resolution ||
    VIDEO_CONFIG
      .defaultResolution;

  if (
    videoModel ===
    'agnes-video-v2.0'
  ) {
    resolution =
      '720P';
  }

  if (
    videoModel ===
    'agnes-video-2.5-flash'
  ) {
    resolution =
      '720P';
  }

  const modelError =
    validateVideoModel(
      videoModel
    );

  if (modelError) {
    return {
      error:
        modelError,
    };
  }

  const aspectError =
    validateAspectRatio(
      aspectRatio
    );

  if (aspectError) {
    return {
      error:
        aspectError,
    };
  }

  const durationError =
    validateDuration(
      videoModel,
      durationSeconds
    );

  if (durationError) {
    return {
      error:
        durationError,
    };
  }

  const resolutionError =
    validateResolution(
      videoModel,
      resolution
    );

  if (resolutionError) {
    return {
      error:
        resolutionError,
    };
  }

  return {
    videoModel,

    aspectRatio,

    durationSeconds,

    resolution,

    error:
      null,
  };
}

/* =========================================================
   PROMPT API
========================================================= */

app.use(
  '/api/prompt',
  promptRouter
);

/* =========================================================
   REFERENCE IMAGE SERVER
========================================================= */

app.get(
  '/api/images/:id',

  (req, res) => {
    const entry =
      getImageFromStore(
        req.params.id
      );

    if (!entry) {
      return res
        .status(404)
        .json({
          ok:
            false,

          error:
            'Image not found or expired',
        });
    }

    res.setHeader(
      'Content-Type',
      entry.mimeType
    );

    res.setHeader(
      'Cache-Control',
      'public, max-age=21600'
    );

    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );

    res.send(
      entry.buffer
    );
  }
);

/* =========================================================
   HEALTH / CONFIG
========================================================= */

app.get(
  '/api/health',

  (req, res) => {
    res.json({
      ok:
        true,

      service:
        'AI Video Maker',

      agnesConfigured:
        Boolean(
          process.env
            .AGNES_API_KEY
        ),

      models:
        VIDEO_MODELS,

      defaultModel:
        VIDEO_CONFIG
          .defaultModel,

      aspectRatios:
        VIDEO_CONFIG
          .aspectRatios,

      legacyFrameRate:
        VIDEO_CONFIG
          .frame_rate,

      timeoutMinutes:
        MAX_JOB_TIME /
        60000,
    });
  }
);

app.get(
  '/api/config',

  (req, res) => {
    res.json({
      ok:
        true,

      models:
        VIDEO_MODELS,

      defaultModel:
        VIDEO_CONFIG
          .defaultModel,

      defaultAspectRatio:
        VIDEO_CONFIG
          .defaultAspectRatio,

      defaultDurationSeconds:
        VIDEO_CONFIG
          .defaultDurationSeconds,

      defaultResolution:
        VIDEO_CONFIG
          .defaultResolution,

      frameRate:
        VIDEO_CONFIG
          .frame_rate,

      maxRetries:
        MAX_RETRIES,
    });
  }
);

/* =========================================================
   TEXT -> VIDEO
========================================================= */

app.post(
  '/api/generate',

  (req, res) => {
    const {
      prompt,

      qualityMode =
        'high',
    } =
      req.body || {};

    const promptError =
      validatePrompt(
        prompt
      );

    if (promptError) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            promptError,
        });
    }

    const settings =
      validateGenerationSettings(
        req.body || {}
      );

    if (settings.error) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            settings.error,
        });
    }

    const jobId =
      createJobId();

    jobs.set(
      jobId,

      {
        jobId,

        type:
          'text',

        prompt:
          prompt.trim(),

        qualityMode,

        videoModel:
          settings.videoModel,

        aspectRatio:
          settings.aspectRatio,

        durationSeconds:
          settings.durationSeconds,

        resolution:
          settings.resolution,

        status:
          'starting',

        progress:
          0,

        videoUrl:
          null,

        error:
          null,

        attempt:
          1,

        maxAttempts:
          MAX_RETRIES +
          1,

        createdAt:
          Date.now(),

        updatedAt:
          Date.now(),
      }
    );

    res.json({
      ok:
        true,

      ...clientJob(
        jobs.get(
          jobId
        )
      ),
    });

    generateTextJob(
      jobId
    ).catch(
      (error) => {
        console.error(
          'Background text job error:',
          error
        );

        updateJob(
          jobId,

          {
            status:
              'failed',

            error:
              error.message,
          }
        );
      }
    );
  }
);

/* =========================================================
   IMAGE -> VIDEO
========================================================= */

app.post(
  '/api/generate-image',

  (req, res) => {
    const {
      prompt,

      imageData,

      imageUrl,

      qualityMode =
        'high',
    } =
      req.body || {};

    const promptError =
      validatePrompt(
        prompt
      );

    if (promptError) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            promptError,
        });
    }

    const settings =
      validateGenerationSettings(
        req.body || {}
      );

    if (settings.error) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            settings.error,
        });
    }

    if (
      !imageData &&
      !imageUrl
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            'Image upload karein / Ctrl+V se paste karein ya image URL daalein.',
        });
    }

    const dataError =
      validateImageDataInput(
        imageData
      );

    if (dataError) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            dataError,
        });
    }

    const urlError =
      imageData
        ? null
        : validateImageUrlInput(
            imageUrl
          );

    if (urlError) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            urlError,
        });
    }

    const jobId =
      createJobId();

    jobs.set(
      jobId,

      {
        jobId,

        type:
          'image',

        prompt:
          prompt.trim(),

        imageData:
          imageData ||
          null,

        imageUrl:
          imageUrl
            ? normalizeImageUrl(
                imageUrl
              )
            : null,

        qualityMode,

        videoModel:
          settings.videoModel,

        aspectRatio:
          settings.aspectRatio,

        durationSeconds:
          settings.durationSeconds,

        resolution:
          settings.resolution,

        status:
          'starting',

        progress:
          0,

        videoUrl:
          null,

        error:
          null,

        attempt:
          1,

        maxAttempts:
          1,

        createdAt:
          Date.now(),

        updatedAt:
          Date.now(),
      }
    );

    res.json({
      ok:
        true,

      ...clientJob(
        jobs.get(
          jobId
        )
      ),
    });

    generateImageJob(
      jobId
    ).catch(
      (error) => {
        console.error(
          'Background image job error:',
          error
        );

        updateJob(
          jobId,

          {
            status:
              'failed',

            error:
              error.message,
          }
        );
      }
    );
  }
);

/* =========================================================
   TEXT GENERATION
========================================================= */

async function generateTextJob(
  jobId
) {
  const job =
    jobs.get(
      jobId
    );

  if (!job) {
    return;
  }

  try {
    updateJob(
      jobId,

      {
        status:
          'optimizing_prompt',

        progress:
          2,
      }
    );

    const result =
      await createVideoTask(
        {
          prompt:
            job.prompt,

          qualityMode:
            job.qualityMode,

          hasReferenceImage:
            false,

          aspectRatio:
            job.aspectRatio,

          durationSeconds:
            job.durationSeconds,

          modelId:
            job.videoModel,

          resolution:
            job.resolution,
        }
      );

    updateJob(
      jobId,

      {
        status:
          result.status ||
          'queued',

        progress:
          result.progress ||
          5,

        agnesVideoId:
          result.videoId,

        agnesTaskId:
          result.taskId,

        finalPrompt:
          result.finalPrompt,

        negativePrompt:
          result.negativePrompt,
      }
    );

    await pollJob(
      jobId
    );
  } catch (error) {
    updateJob(
      jobId,

      {
        status:
          'failed',

        error:
          error.message,
      }
    );
  }
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

async function generateImageJob(
  jobId
) {
  const job =
    jobs.get(
      jobId
    );

  if (!job) {
    return;
  }

  let candidates =
    [];

  try {
    updateJob(
      jobId,

      {
        status:
          'preparing_image',

        progress:
          3,
      }
    );

    const dimensions =
      getReferenceImageDimensions(
        job.aspectRatio
      );

    const prepared =
      await buildPublicImageUrls(
        {
          imageData:
            job.imageData,

          imageUrl:
            job.imageUrl,

          targetWidth:
            dimensions.width,

          targetHeight:
            dimensions.height,
        }
      );

    candidates =
      prepared.candidates;

    prepared.notes.forEach(
      (note) =>
        console.log(
          `[${jobId}] image:`,
          note
        )
    );

    updateJob(
      jobId,

      {
        status:
          'optimizing_prompt',

        progress:
          8,

        imageHost:
          candidates[0]
            ?.host ||
          null,

        resolvedImageUrl:
          candidates[0]
            ?.url ||
          null,

        imageData:
          null,
      }
    );
  } catch (error) {
    updateJob(
      jobId,

      {
        status:
          'failed',

        error:
          error.message,

        hint:
          'Chhoti PNG/JPG image try karein.',
      }
    );

    return;
  }

  let lastError =
    null;

  for (
    let i = 0;
    i <
    candidates.length;
    i++
  ) {
    const candidate =
      candidates[i];

    try {
      console.log(
        `[${jobId}] Agnes ${job.videoModel} ko image bhej rahe hain (${candidate.host})`
      );

      const result =
        await createImageVideoTask(
          {
            prompt:
              job.prompt,

            imageUrl:
              candidate.url,

            qualityMode:
              job.qualityMode,

            aspectRatio:
              job.aspectRatio,

            durationSeconds:
              job.durationSeconds,

            modelId:
              job.videoModel,

            resolution:
              job.resolution,
          }
        );

      updateJob(
        jobId,

        {
          status:
            result.status ||
            'queued',

          progress:
            result.progress ||
            5,

          agnesVideoId:
            result.videoId,

          agnesTaskId:
            result.taskId,

          finalPrompt:
            result.finalPrompt,

          negativePrompt:
            result.negativePrompt,

          imageHost:
            candidate.host,

          resolvedImageUrl:
            candidate.url,

          error:
            null,
        }
      );

      await pollJob(
        jobId
      );

      return;
    } catch (error) {
      lastError =
        error;

      console.error(
        `[${jobId}] ${candidate.host} failed:`,
        error.message
      );

      const canRetry =
        isImageDownloadError(
          error.message
        ) &&
        i <
          candidates.length -
            1;

      if (!canRetry) {
        break;
      }

      updateJob(
        jobId,

        {
          status:
            'retrying_image_host',

          progress:
            4,

          error:
            `${candidate.host} fail hua, doosra image host try ho raha hai...`,
        }
      );
    }
  }

  const message =
    lastError?.message ||
    'Image-to-video request fail ho gayi.';

  updateJob(
    jobId,

    {
      status:
        'failed',

      error:
        message,

      hint:
        isImageDownloadError(
          message
        )
          ? 'Agnes image URL access nahi kar paaya. Uploaded image try karein.'
          : null,
    }
  );
}

/* =========================================================
   POLLING
========================================================= */

async function pollJob(
  jobId
) {
  const startTime =
    Date.now();

  let consecutiveErrors =
    0;

  while (true) {
    const job =
      jobs.get(
        jobId
      );

    if (!job) {
      return;
    }

    if (
      Date.now() -
        startTime >
      MAX_JOB_TIME
    ) {
      updateJob(
        jobId,

        {
          status:
            'failed',

          error:
            `Video generation ${
              MAX_JOB_TIME /
              60000
            } minute me complete nahi hui.`,
        }
      );

      return;
    }

    if (
      !job.agnesVideoId
    ) {
      updateJob(
        jobId,

        {
          status:
            'failed',

          error:
            'Agnes ne video_id return nahi kiya.',
        }
      );

      return;
    }

    try {
      /*
       * Selected model polling me bhi pass hota hai.
       */
      const result =
        await getVideoStatus(
          job.agnesVideoId,

          job.videoModel
        );

      consecutiveErrors =
        0;

      updateJob(
        jobId,

        {
          status:
            result.status,

          progress:
            result.progress ||
            job.progress ||
            0,

          videoUrl:
            result.videoUrl ||
            job.videoUrl ||
            null,

          error:
            result.status ===
            'failed'
              ? result.error
              : null,
        }
      );

      console.log(
        `[${jobId}]`,

        job.videoModel,

        result.status,

        `${result.progress || 0}%`,

        result.rawStatus
          ? `(agnes: ${result.rawStatus})`
          : ''
      );

      if (
        result.status ===
        'completed'
      ) {
        let expectedDuration;

        if (
          isLegacyModel(
            job.videoModel
          )
        ) {
          const durationConfig =
            getLegacyDurationConfig(
              job.durationSeconds
            );

          expectedDuration =
            durationConfig
              .num_frames /
            VIDEO_CONFIG
              .frame_rate;
        } else {
          expectedDuration =
            Number(
              job.durationSeconds
            );
        }

        const quality =
          await validateGeneratedVideo(
            {
              videoUrl:
                result.videoUrl,

              expectedDuration,
            }
          );

        if (
          !quality.passed
        ) {
          const current =
            jobs.get(
              jobId
            );

          if (
            current.type ===
              'text' &&
            current.attempt <
              MAX_RETRIES +
                1
          ) {
            updateJob(
              jobId,

              {
                status:
                  'retrying',

                progress:
                  0,

                attempt:
                  current.attempt +
                  1,

                error:
                  quality.reason,
              }
            );

            const retry =
              await createVideoTask(
                {
                  prompt: `${current.prompt}

CORRECTION PASS:
Maintain the exact same subject identity and geometry.
Use stable realistic physics.
Avoid morphing, duplication, melting geometry,
extra limbs, sudden object replacement,
camera teleportation and flickering.
Keep motion smooth and cinematic.`,

                  qualityMode:
                    current.qualityMode,

                  hasReferenceImage:
                    false,

                  aspectRatio:
                    current.aspectRatio,

                  durationSeconds:
                    current.durationSeconds,

                  modelId:
                    current.videoModel,

                  resolution:
                    current.resolution,
                }
              );

            updateJob(
              jobId,

              {
                status:
                  retry.status ||
                  'queued',

                progress:
                  retry.progress ||
                  5,

                agnesVideoId:
                  retry.videoId,

                agnesTaskId:
                  retry.taskId,
              }
            );

            continue;
          }

          updateJob(
            jobId,

            {
              status:
                'failed',

              error:
                quality.reason,
            }
          );

          return;
        }

        updateJob(
          jobId,

          {
            status:
              'completed',

            progress:
              100,

            videoUrl:
              result.videoUrl,

            error:
              null,
          }
        );

        return;
      }

      if (
        result.status ===
        'failed'
      ) {
        updateJob(
          jobId,

          {
            status:
              'failed',

            error:
              result.error ||
              'Agnes video generation fail ho gaya.',
          }
        );

        return;
      }
    } catch (error) {
      consecutiveErrors +=
        1;

      console.error(
        `[${jobId}] polling error:`,
        error.message
      );

      if (
        consecutiveErrors >=
        10
      ) {
        updateJob(
          jobId,

          {
            status:
              'failed',

            error:
              `Agnes status check baar baar fail hua: ${error.message}`,
          }
        );

        return;
      }
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          POLL_INTERVAL
        )
    );
  }
}

/* =========================================================
   STATUS API
========================================================= */

app.get(
  '/api/status/:jobId',

  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          ok:
            false,

          error:
            'Job not found',
        });
    }

    res.json({
      ok:
        true,

      ...clientJob(
        job
      ),
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

const FRONTEND_DIST =
  path.join(
    __dirname,

    '..',

    'frontend',

    'dist',

    'frontend',

    'browser'
  );

app.use(
  express.static(
    FRONTEND_DIST
  )
);

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        '/api/'
      )
    ) {
      return res
        .status(404)
        .json({
          ok:
            false,

          error:
            `API endpoint not found: ${req.method} ${req.path}`,
        });
    }

    res.sendFile(
      path.join(
        FRONTEND_DIST,
        'index.html'
      ),

      (error) => {
        if (error) {
          res
            .status(404)
            .json({
              ok:
                false,

              error:
                'Not found',
            });
        }
      }
    );
  }
);

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      'Server error:',
      error
    );

    if (
      error.type ===
      'entity.too.large'
    ) {
      return res
        .status(413)
        .json({
          ok:
            false,

          error:
            'Image/request bahut bada hai.',
        });
    }

    res
      .status(500)
      .json({
        ok:
          false,

        error:
          error.message ||
          'Internal server error',
      });
  }
);

/* =========================================================
   START
========================================================= */

if (
  require.main ===
  module
) {
  app.listen(
    PORT,

    () => {
      console.log('');
      console.log(
        '======================================'
      );
      console.log(
        ' AI Video Maker'
      );
      console.log(
        '======================================'
      );

      console.log(
        `Server: http://localhost:${PORT}`
      );

      console.log(
        'Supported models:'
      );

      Object.values(
        VIDEO_MODELS
      ).forEach(
        (model) => {
          console.log(
            ` - ${model.id} (${model.freeLabel})`
          );
        }
      );

      console.log(
        `Video 2.0 FPS: ${VIDEO_CONFIG.frame_rate}`
      );

      console.log(
        'Video 2.0 durations: 12s / 18s'
      );

      console.log(
        'Video 2.5 durations: 4s - 12s'
      );

      console.log(
        'Video 2.5 Flash: 720P only'
      );

      if (
        !process.env
          .AGNES_API_KEY
      ) {
        console.warn(
          '⚠️ AGNES_API_KEY missing.'
        );
      }

      logPromptStartupState();

      console.log(
        '======================================'
      );
      console.log('');
    }
  );
}

module.exports =
  app;