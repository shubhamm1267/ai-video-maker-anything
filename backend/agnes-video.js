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

const AGNES_API_KEY =
  process.env.AGNES_API_KEY;

const AGNES_BASE_URL =
  process.env.AGNES_API_BASE ||
  'https://apihub.agnes-ai.com';

/*
 * ---------------------------------------------------------
 * AGNES MODELS
 * ---------------------------------------------------------
 *
 * Video 2.0:
 *   Legacy schema:
 *   width / height / num_frames / frame_rate
 *
 * Video 2.5:
 *   Modern schema:
 *   mode / seconds / size / aspect_ratio
 *
 * Video 2.5 Flash:
 *   Modern schema
 *   size MUST be 720P
 */

const VIDEO_MODELS = {
  'agnes-video-v2.0': {
    id: 'agnes-video-v2.0',

    family: 'legacy',

    label: 'Video 2.0',

    freeLabel: 'Free promo',

    defaultDuration: 12,

    allowedDurations: [
      12,
      18,
    ],

    allowedResolutions: [
      '720P',
    ],
  },

  'agnes-video-2.5': {
    id: 'agnes-video-2.5',

    family: 'modern',

    label: 'Video 2.5',

    freeLabel: 'Paid',

    defaultDuration: 12,

    allowedDurations: [
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
    ],

    allowedResolutions: [
      '720P',
      '1080P',
      '1K',
      '2K',
    ],
  },

  'agnes-video-2.5-flash': {
    id: 'agnes-video-2.5-flash',

    family: 'modern',

    label: 'Video 2.5 Flash',

    freeLabel: 'Free promo now',

    defaultDuration: 12,

    allowedDurations: [
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
    ],

    allowedResolutions: [
      '720P',
    ],
  },
};

const VIDEO_CONFIG = {
  defaultModel:
    'agnes-video-v2.0',

  frame_rate:
    24,

  defaultAspectRatio:
    '9:16',

  defaultDurationSeconds:
    12,

  defaultResolution:
    '720P',

  /*
   * Video 2.0 output size.
   */
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

  /*
   * Video 2.0 only.
   *
   * 289 / 24 = 12.04 sec
   * 433 / 24 = 18.04 sec
   */
  legacyDurations: {
    12: {
      durationSeconds: 12,
      num_frames: 289,
    },

    18: {
      durationSeconds: 18,
      num_frames: 433,
    },
  },

  models:
    VIDEO_MODELS,
};

function getModelConfig(
  modelId =
    VIDEO_CONFIG.defaultModel
) {
  return (
    VIDEO_MODELS[modelId] ||
    VIDEO_MODELS[
      VIDEO_CONFIG.defaultModel
    ]
  );
}

function isModernModel(
  modelId
) {
  return (
    getModelConfig(
      modelId
    ).family ===
    'modern'
  );
}

function isLegacyModel(
  modelId
) {
  return !isModernModel(
    modelId
  );
}

function getVideoDimensions(
  aspectRatio =
    VIDEO_CONFIG.defaultAspectRatio
) {
  return (
    VIDEO_CONFIG.aspectRatios[
      aspectRatio
    ] ||
    VIDEO_CONFIG.aspectRatios[
      VIDEO_CONFIG.defaultAspectRatio
    ]
  );
}

/*
 * Reference image ko ratio me crop karne ke liye.
 *
 * 2.5 ka actual output resolution API ke "size"
 * field se control hoga.
 */
function getReferenceImageDimensions(
  aspectRatio
) {
  return getVideoDimensions(
    aspectRatio
  );
}

function getLegacyDurationConfig(
  durationSeconds =
    VIDEO_CONFIG.defaultDurationSeconds
) {
  const duration =
    Number(
      durationSeconds
    );

  return (
    VIDEO_CONFIG
      .legacyDurations[
      duration
    ] ||
    VIDEO_CONFIG
      .legacyDurations[
      VIDEO_CONFIG
        .defaultDurationSeconds
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
    Authorization:
      `Bearer ${AGNES_API_KEY}`,

    'Content-Type':
      'application/json',
  };
}

function extractVideoUrl(
  data
) {
  return (
    data?.url ||
    data?.video_url ||
    data?.videoUrl ||
    data?.metadata?.url ||
    data?.output?.url ||
    data?.data?.url ||
    null
  );
}

function extractVideoId(
  data
) {
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
  const status =
    String(
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

  if (
    completed.includes(
      status
    )
  ) {
    return 'completed';
  }

  if (
    failed.includes(
      status
    )
  ) {
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

function readableAgnesError(
  details
) {
  let text =
    typeof details ===
    'string'
      ? details
      : JSON.stringify(
          details || {}
        );

  const match =
    text.match(
      /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/
    );

  if (match) {
    try {
      text =
        JSON.parse(
          `"${match[1]}"`
        );
    } catch {
      text =
        match[1];
    }
  }

  const inner =
    text.match(
      /"message"\s*:\s*\\?"?([^"\\]{5,400})/
    );

  if (
    inner &&
    /Download image URL failed/i.test(
      text
    )
  ) {
    text =
      inner[1];
  }

  return text
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(
      0,
      700
    );
}

function isImageDownloadError(
  message
) {
  return /download image url failed|download.*image.*fail|image url|connection reset by peer|network is unreachable|max retries exceeded/i.test(
    String(
      message || ''
    )
  );
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
    imageUrl.startsWith(
      'data:'
    ) ||
    imageUrl.startsWith(
      'blob:'
    )
  ) {
    throw new Error(
      'Image must be converted to a public image URL before sending to Agnes.'
    );
  }

  if (
    !/^https?:\/\//i.test(
      imageUrl
    )
  ) {
    throw new Error(
      'Image-to-Video requires a public HTTP/HTTPS image URL.'
    );
  }

  return imageUrl;
}

/*
 * ---------------------------------------------------------
 * MODERN 2.5 PROMPT
 * ---------------------------------------------------------
 *
 * 2.5 schema me legacy negative_prompt use nahi karte.
 * Isliye negative instructions prompt ke andar add karte hain.
 */

function buildModernPrompt(
  prompt,
  negativePrompt
) {
  if (!negativePrompt) {
    return prompt;
  }

  return `${prompt}

IMPORTANT VISUAL CONSISTENCY RULES:
Avoid the following visual problems:
${negativePrompt}

Maintain stable subject identity, geometry, colors, environment and camera continuity throughout the entire video.`;
}

/*
 * ---------------------------------------------------------
 * LEGACY 2.0 PAYLOAD
 * ---------------------------------------------------------
 */

function createLegacyPayload({
  prompt,
  negativePrompt,
  aspectRatio,
  durationSeconds,
  imageUrl = null,
}) {
  const dimensions =
    getVideoDimensions(
      aspectRatio
    );

  const durationConfig =
    getLegacyDurationConfig(
      durationSeconds
    );

  const payload = {
    model:
      'agnes-video-v2.0',

    prompt,

    width:
      dimensions.width,

    height:
      dimensions.height,

    num_frames:
      durationConfig.num_frames,

    frame_rate:
      VIDEO_CONFIG.frame_rate,

    negative_prompt:
      negativePrompt,
  };

  if (imageUrl) {
    payload.image =
      imageUrl;
  }

  return payload;
}

/*
 * ---------------------------------------------------------
 * MODERN 2.5 / FLASH PAYLOAD
 * ---------------------------------------------------------
 */

function createModernPayload({
  modelId,
  prompt,
  negativePrompt,
  aspectRatio,
  durationSeconds,
  resolution,
  imageUrl = null,
}) {
  const model =
    getModelConfig(
      modelId
    );

  let finalResolution =
    resolution ||
    VIDEO_CONFIG
      .defaultResolution;

  /*
   * Flash hard restriction:
   * 720P only.
   */
  if (
    modelId ===
    'agnes-video-2.5-flash'
  ) {
    finalResolution =
      '720P';
  }

  const finalPrompt =
    buildModernPrompt(
      prompt,
      negativePrompt
    );

  const payload = {
    model:
      model.id,

    prompt:
      finalPrompt,

    mode:
      imageUrl
        ? 'keyframe'
        : 'text',

    seconds:
      String(
        durationSeconds
      ),

    size:
      finalResolution,

    aspect_ratio:
      aspectRatio,

    n:
      1,
  };

  /*
   * Single-image video ke liye image ko
   * first frame ke roop me lock karte hain.
   */
  if (imageUrl) {
    payload.first_frame =
      imageUrl;
  }

  return payload;
}

function createPayload({
  modelId,
  prompt,
  negativePrompt,
  aspectRatio,
  durationSeconds,
  resolution,
  imageUrl = null,
}) {
  if (
    isLegacyModel(
      modelId
    )
  ) {
    return createLegacyPayload({
      prompt,
      negativePrompt,
      aspectRatio,
      durationSeconds,
      imageUrl,
    });
  }

  return createModernPayload({
    modelId,
    prompt,
    negativePrompt,
    aspectRatio,
    durationSeconds,
    resolution,
    imageUrl,
  });
}

function buildFinalPrompt({
  prompt,
  qualityMode,
  hasReferenceImage,
}) {
  const compiled =
    compileVideoPrompt({
      prompt,

      hasReferenceImage,

      mode:
        qualityMode,
    });

  const consistency =
    buildConsistencyConfig({
      hasReferenceImage,

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

  return {
    finalPrompt,

    negativePrompt:
      compiled.negativePrompt,
  };
}

async function postVideoRequest(
  payload
) {
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

  return (
    response.data || {}
  );
}

async function createVideoTask({
  prompt,

  qualityMode =
    'high',

  hasReferenceImage =
    false,

  aspectRatio =
    VIDEO_CONFIG
      .defaultAspectRatio,

  durationSeconds =
    VIDEO_CONFIG
      .defaultDurationSeconds,

  modelId =
    VIDEO_CONFIG
      .defaultModel,

  resolution =
    VIDEO_CONFIG
      .defaultResolution,
}) {
  const {
    finalPrompt,
    negativePrompt,
  } =
    buildFinalPrompt({
      prompt,

      qualityMode,

      hasReferenceImage,
    });

  const payload =
    createPayload({
      modelId,

      prompt:
        finalPrompt,

      negativePrompt,

      aspectRatio,

      durationSeconds,

      resolution,
    });

  console.log(
    'Creating Agnes text-to-video task:',
    {
      model:
        modelId,

      aspectRatio,

      durationSeconds,

      resolution,

      frameRate:
        isLegacyModel(
          modelId
        )
          ? VIDEO_CONFIG
              .frame_rate
          : 'model-managed',

      numFrames:
        payload.num_frames ||
        'model-managed',
    }
  );

  try {
    const data =
      await postVideoRequest(
        payload
      );

    console.log(
      'Agnes create response:',
      {
        model:
          modelId,

        video_id:
          data.video_id,

        task_id:
          data.task_id,

        status:
          data.status,
      }
    );

    return {
      modelId,

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

      negativePrompt,

      durationSeconds:
        Number(
          durationSeconds
        ),

      resolution,

      frameRate:
        isLegacyModel(
          modelId
        )
          ? VIDEO_CONFIG
              .frame_rate
          : null,

      numFrames:
        payload.num_frames ||
        null,
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

  qualityMode =
    'high',

  aspectRatio =
    VIDEO_CONFIG
      .defaultAspectRatio,

  durationSeconds =
    VIDEO_CONFIG
      .defaultDurationSeconds,

  modelId =
    VIDEO_CONFIG
      .defaultModel,

  resolution =
    VIDEO_CONFIG
      .defaultResolution,
}) {
  const validImageUrl =
    validateImageReference(
      imageUrl
    );

  const {
    finalPrompt,
    negativePrompt,
  } =
    buildFinalPrompt({
      prompt,

      qualityMode,

      hasReferenceImage:
        true,
    });

  const payload =
    createPayload({
      modelId,

      prompt:
        finalPrompt,

      negativePrompt,

      aspectRatio,

      durationSeconds,

      resolution,

      imageUrl:
        validImageUrl,
    });

  console.log(
    'Creating Agnes image-to-video task:',
    {
      model:
        modelId,

      aspectRatio,

      durationSeconds,

      resolution,

      imageMode:
        isLegacyModel(
          modelId
        )
          ? 'image'
          : 'keyframe / first_frame',
    }
  );

  try {
    const data =
      await postVideoRequest(
        payload
      );

    console.log(
      'Agnes image create response:',
      {
        model:
          modelId,

        video_id:
          data.video_id,

        task_id:
          data.task_id,

        status:
          data.status,
      }
    );

    return {
      modelId,

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

      negativePrompt,

      durationSeconds:
        Number(
          durationSeconds
        ),

      resolution,

      frameRate:
        isLegacyModel(
          modelId
        )
          ? VIDEO_CONFIG
              .frame_rate
          : null,

      numFrames:
        payload.num_frames ||
        null,
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

  qualityMode =
    'high',

  aspectRatio =
    VIDEO_CONFIG
      .defaultAspectRatio,

  durationSeconds =
    VIDEO_CONFIG
      .defaultDurationSeconds,

  modelId =
    VIDEO_CONFIG
      .defaultModel,

  resolution =
    VIDEO_CONFIG
      .defaultResolution,
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

    modelId,

    resolution,
  });
}

/*
 * IMPORTANT:
 *
 * model_name dynamically bhejna zaroori hai.
 * Agar 2.5 Flash generate hua aur polling me
 * v2.0 bhej diya to result nahi milega.
 */
async function getVideoStatus(
  videoId,

  modelId =
    VIDEO_CONFIG.defaultModel
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
              modelId,
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

      modelId,

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
        data.metadata
          ?.error ||
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

  VIDEO_MODELS,

  getModelConfig,

  isModernModel,

  isLegacyModel,

  getVideoDimensions,

  getReferenceImageDimensions,

  getLegacyDurationConfig,
};