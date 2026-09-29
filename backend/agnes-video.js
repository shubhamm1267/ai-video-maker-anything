require('dotenv').config();

const axios = require('axios');

const {
  compileVideoPrompt,
  buildRetryPrompt,
} = require('./prompt-engine');

const {
  buildConsistencyConfig,
  getConsistencyPrompt,
} = require('./consistency-engine');

const {
  buildPhysicsPrompt,
} = require('./physics-engine');

const AGNES_API_KEY = process.env.AGNES_API_KEY;

const AGNES_BASE_URL =
  process.env.AGNES_API_BASE ||
  'https://apihub.agnes-ai.com';

const MODEL = 'agnes-video-v2.0';

/*
 * IMPORTANT:
 *
 * FPS hamesha 24 rahega.
 *
 * 12 sec:
 * 289 / 24 = 12.04 sec
 *
 * 18 sec:
 * 433 / 24 = 18.04 sec
 *
 * Dono frame counts 8n+1 rule follow karte hain.
 */
const VIDEO_CONFIG = {
  frame_rate: 24,

  defaultAspectRatio: '9:16',

  defaultDurationSeconds: 12,

  aspectRatios: {
    '9:16': {
      width: 720,
      height: 1280,
    },

    '16:9': {
      width: 1280,
      height: 720,
    },
  },

  durations: {
    12: {
      durationSeconds: 12,
      num_frames: 289,
    },

    18: {
      durationSeconds: 18,
      num_frames: 433,
    },
  },
};

function getVideoDimensions(
  aspectRatio = VIDEO_CONFIG.defaultAspectRatio
) {
  return (
    VIDEO_CONFIG.aspectRatios[aspectRatio] ||
    VIDEO_CONFIG.aspectRatios[
      VIDEO_CONFIG.defaultAspectRatio
    ]
  );
}

function getDurationConfig(
  durationSeconds = VIDEO_CONFIG.defaultDurationSeconds
) {
  const duration =
    Number(durationSeconds);

  return (
    VIDEO_CONFIG.durations[duration] ||
    VIDEO_CONFIG.durations[
      VIDEO_CONFIG.defaultDurationSeconds
    ]
  );
}

function getHeaders() {
  if (!AGNES_API_KEY) {
    throw new Error(
      'AGNES_API_KEY is missing in backend/.env'
    );
  }

  return {
    Authorization: `Bearer ${AGNES_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function extractVideoUrl(data) {
  return (
    data?.url ||
    data?.video_url ||
    data?.videoUrl ||
    data?.output?.url ||
    data?.data?.url ||
    null
  );
}

function extractVideoId(data) {
  return (
    data?.video_id ||
    data?.videoId ||
    null
  );
}

function normalizeStatus(
  rawStatus,
  hasVideoUrl
) {
  const status = String(
    rawStatus || ''
  )
    .toLowerCase()
    .trim();

  const completed = [
    'completed',
    'complete',
    'succeed',
    'succeeded',
    'success',
    'successful',
    'finished',
    'finish',
    'done',
    'ready',
  ];

  const failed = [
    'failed',
    'fail',
    'error',
    'errored',
    'cancelled',
    'canceled',
    'rejected',
    'timeout',
  ];

  if (completed.includes(status)) {
    return 'completed';
  }

  if (failed.includes(status)) {
    return 'failed';
  }

  if (hasVideoUrl) {
    return 'completed';
  }

  if (!status) {
    return 'in_progress';
  }

  if (
    [
      'queued',
      'queueing',
      'pending',
      'waiting',
      'submitted',
    ].includes(status)
  ) {
    return 'queued';
  }

  return 'in_progress';
}

function readableAgnesError(details) {
  let text =
    typeof details === 'string'
      ? details
      : JSON.stringify(details || {});

  const match = text.match(
    /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/
  );

  if (match) {
    try {
      text = JSON.parse(
        `"${match[1]}"`
      );
    } catch {
      text = match[1];
    }
  }

  const inner = text.match(
    /"message"\s*:\s*\\?"?([^"\\]{5,400})/
  );

  if (
    inner &&
    /Download image URL failed/i.test(text)
  ) {
    text = inner[1];
  }

  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isImageDownloadError(message) {
  return /download image url failed|download.*image.*fail|image url|connection reset by peer|network is unreachable|max retries exceeded/i.test(
    String(message || '')
  );
}

function createBasePayload(
  prompt,
  negativePrompt,
  aspectRatio = VIDEO_CONFIG.defaultAspectRatio,
  durationSeconds = VIDEO_CONFIG.defaultDurationSeconds
) {
  const dimensions =
    getVideoDimensions(aspectRatio);

  const durationConfig =
    getDurationConfig(durationSeconds);

  return {
    model: MODEL,

    prompt,

    width: dimensions.width,

    height: dimensions.height,

    num_frames:
      durationConfig.num_frames,

    frame_rate:
      VIDEO_CONFIG.frame_rate,

    negative_prompt:
      negativePrompt,
  };
}

function validateImageReference(
  imageUrl
) {
  if (!imageUrl) {
    throw new Error(
      'Image reference is required'
    );
  }

  if (
    imageUrl.startsWith('data:') ||
    imageUrl.startsWith('blob:')
  ) {
    throw new Error(
      'Image must be converted to a public image URL before sending to Agnes v2.0.'
    );
  }

  if (
    !/^https?:\/\//i.test(imageUrl)
  ) {
    throw new Error(
      'Image-to-Video requires a public HTTP/HTTPS image URL.'
    );
  }

  return imageUrl;
}

async function createVideoTask({
  prompt,
  qualityMode = 'high',
  hasReferenceImage = false,
  aspectRatio = VIDEO_CONFIG.defaultAspectRatio,
  durationSeconds = VIDEO_CONFIG.defaultDurationSeconds,
}) {
  const compiled =
    compileVideoPrompt({
      prompt,
      hasReferenceImage,
      mode: qualityMode,
    });

  const consistency =
    buildConsistencyConfig({
      hasReferenceImage,
      lockCharacter: true,
      lockObjects: true,
    });

  const finalPrompt = [
    compiled.prompt,

    getConsistencyPrompt(
      consistency
    ),

    buildPhysicsPrompt(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload =
    createBasePayload(
      finalPrompt,
      compiled.negativePrompt,
      aspectRatio,
      durationSeconds
    );

  console.log(
    'Creating Agnes text-to-video task...',
    {
      aspectRatio,
      durationSeconds,
      num_frames:
        payload.num_frames,
      frame_rate:
        payload.frame_rate,
      width:
        payload.width,
      height:
        payload.height,
    }
  );

  try {
    const response =
      await axios.post(
        `${AGNES_BASE_URL}/v1/videos`,

        payload,

        {
          headers:
            getHeaders(),

          timeout:
            120000,

          maxContentLength:
            Infinity,

          maxBodyLength:
            Infinity,
        }
      );

    const data =
      response.data || {};

    console.log(
      'Agnes create response:',
      {
        video_id:
          data.video_id,

        task_id:
          data.task_id,

        status:
          data.status,
      }
    );

    return {
      videoId:
        extractVideoId(data),

      taskId:
        data.task_id ||
        data.id ||
        null,

      status:
        normalizeStatus(
          data.status ||
            'queued',

          Boolean(
            extractVideoUrl(
              data
            )
          )
        ),

      progress:
        Number(
          data.progress || 0
        ),

      videoUrl:
        extractVideoUrl(data),

      finalPrompt,

      negativePrompt:
        compiled.negativePrompt,

      durationSeconds:
        Number(
          durationSeconds
        ),

      numFrames:
        payload.num_frames,

      frameRate:
        payload.frame_rate,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response
        ?.statusText ||
      error.message;

    console.error(
      'Agnes create error:',
      details
    );

    throw new Error(
      readableAgnesError(
        details
      )
    );
  }
}

async function createImageVideoTask({
  prompt,
  imageUrl,
  qualityMode = 'high',
  aspectRatio = VIDEO_CONFIG.defaultAspectRatio,
  durationSeconds = VIDEO_CONFIG.defaultDurationSeconds,
}) {
  const validImageUrl =
    validateImageReference(
      imageUrl
    );

  const compiled =
    compileVideoPrompt({
      prompt,

      hasReferenceImage:
        true,

      mode:
        qualityMode,
    });

  const consistency =
    buildConsistencyConfig({
      hasReferenceImage:
        true,

      lockCharacter:
        true,

      lockObjects:
        true,
    });

  const finalPrompt = [
    compiled.prompt,

    getConsistencyPrompt(
      consistency
    ),

    buildPhysicsPrompt(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload =
    createBasePayload(
      finalPrompt,
      compiled.negativePrompt,
      aspectRatio,
      durationSeconds
    );

  payload.image =
    validImageUrl;

  console.log(
    'Creating Agnes image-to-video task...',
    {
      aspectRatio,
      durationSeconds,
      num_frames:
        payload.num_frames,
      frame_rate:
        payload.frame_rate,
      width:
        payload.width,
      height:
        payload.height,
    }
  );

  try {
    const response =
      await axios.post(
        `${AGNES_BASE_URL}/v1/videos`,

        payload,

        {
          headers:
            getHeaders(),

          timeout:
            120000,

          maxContentLength:
            Infinity,

          maxBodyLength:
            Infinity,
        }
      );

    const data =
      response.data || {};

    console.log(
      'Agnes image create response:',
      {
        video_id:
          data.video_id,

        task_id:
          data.task_id,

        status:
          data.status,
      }
    );

    return {
      videoId:
        extractVideoId(
          data
        ),

      taskId:
        data.task_id ||
        data.id ||
        null,

      status:
        normalizeStatus(
          data.status ||
            'queued',

          Boolean(
            extractVideoUrl(
              data
            )
          )
        ),

      progress:
        Number(
          data.progress || 0
        ),

      videoUrl:
        extractVideoUrl(
          data
        ),

      finalPrompt,

      negativePrompt:
        compiled.negativePrompt,

      durationSeconds:
        Number(
          durationSeconds
        ),

      numFrames:
        payload.num_frames,

      frameRate:
        payload.frame_rate,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response
        ?.statusText ||
      error.message;

    console.error(
      'Agnes image-to-video error:',
      details
    );

    throw new Error(
      readableAgnesError(
        details
      )
    );
  }
}

async function createRetryTask({
  originalPrompt,
  attempt,
  qualityMode = 'high',
  aspectRatio = VIDEO_CONFIG.defaultAspectRatio,
  durationSeconds = VIDEO_CONFIG.defaultDurationSeconds,
}) {
  const retryPrompt =
    buildRetryPrompt(
      originalPrompt,
      attempt
    );

  return createVideoTask({
    prompt:
      retryPrompt,

    qualityMode,

    hasReferenceImage:
      false,

    aspectRatio,

    durationSeconds,
  });
}

async function getVideoStatus(
  videoId
) {
  if (!videoId) {
    throw new Error(
      'Agnes videoId is missing'
    );
  }

  try {
    const response =
      await axios.get(
        `${AGNES_BASE_URL}/agnesapi`,

        {
          params: {
            video_id:
              videoId,

            model_name:
              MODEL,
          },

          headers: {
            Authorization:
              `Bearer ${AGNES_API_KEY}`,
          },

          timeout:
            60000,
        }
      );

    const data =
      response.data || {};

    const videoUrl =
      extractVideoUrl(
        data
      );

    return {
      videoId:
        data.video_id ||
        videoId,

      status:
        normalizeStatus(
          data.status,

          Boolean(
            videoUrl
          )
        ),

      rawStatus:
        data.status ||
        null,

      progress:
        Number(
          data.progress ||
            0
        ),

      videoUrl,

      error:
        data.error ||
        data.message ||
        null,

      raw:
        data,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response
        ?.statusText ||
      error.message;

    throw new Error(
      readableAgnesError(
        details
      )
    );
  }
}

module.exports = {
  normalizeStatus,

  readableAgnesError,

  isImageDownloadError,

  createVideoTask,

  createImageVideoTask,

  createRetryTask,

  getVideoStatus,

  VIDEO_CONFIG,

  getVideoDimensions,

  getDurationConfig,
};