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

const VIDEO_CONFIG = {
  width: 1152,
  height: 768,
  num_frames: 289,
  frame_rate: 24,
};

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

/*
 * Agnes har baar same status string nahi bhejta
 * (succeed / success / finished / done...).
 * Sab ko 3 hi states me normalise karte hain,
 * warna completed video bhi "timeout" me fail hoti thi.
 */
function normalizeStatus(rawStatus, hasVideoUrl) {
  const status = String(rawStatus || '').toLowerCase().trim();

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

  if (completed.includes(status)) return 'completed';
  if (failed.includes(status)) return 'failed';

  // Status samajh na aaye par video URL aa gaya = ho gaya.
  if (hasVideoUrl) return 'completed';

  if (!status) return 'in_progress';

  if (
    ['queued', 'queueing', 'pending', 'waiting', 'submitted'].includes(status)
  ) {
    return 'queued';
  }

  return 'in_progress';
}

/*
 * Agnes ka error text JSON ke andar JSON hota hai.
 * User ke liye padhne layak line nikalte hain.
 */
function readableAgnesError(details) {
  let text =
    typeof details === 'string' ? details : JSON.stringify(details || {});

  // Nested JSON ke andar ka asli message dhoondo.
  const match = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      text = JSON.parse(`"${match[1]}"`);
    } catch {
      text = match[1];
    }
  }

  const inner = text.match(/"message"\s*:\s*\\?"?([^"\\]{5,400})/);
  if (inner && /Download image URL failed/i.test(text)) {
    text = inner[1];
  }

  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Kya yeh error "image URL download nahi ho paaya" wala hai? */
function isImageDownloadError(message) {
  return /download image url failed|download.*image.*fail|image url|connection reset by peer|network is unreachable|max retries exceeded/i.test(
    String(message || '')
  );
}

function createBasePayload(
  prompt,
  negativePrompt
) {
  return {
    model: MODEL,
    prompt,

    width: VIDEO_CONFIG.width,
    height: VIDEO_CONFIG.height,

    num_frames: VIDEO_CONFIG.num_frames,
    frame_rate: VIDEO_CONFIG.frame_rate,

    negative_prompt: negativePrompt,
  };
}

function validateImageReference(imageUrl) {
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

  if (!/^https?:\/\//i.test(imageUrl)) {
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
}) {
  const compiled = compileVideoPrompt({
    prompt,
    hasReferenceImage,
    mode: qualityMode,
  });

  const consistency = buildConsistencyConfig({
    hasReferenceImage,
    lockCharacter: true,
    lockObjects: true,
  });

  const finalPrompt = [
    compiled.prompt,
    getConsistencyPrompt(consistency),
    buildPhysicsPrompt(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = createBasePayload(
    finalPrompt,
    compiled.negativePrompt
  );

  console.log(
    'Creating Agnes text-to-video task...'
  );

  try {
    const response = await axios.post(
      `${AGNES_BASE_URL}/v1/videos`,
      payload,
      {
        headers: getHeaders(),
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const data = response.data || {};

    console.log(
      'Agnes create response:',
      {
        video_id: data.video_id,
        task_id: data.task_id,
        status: data.status,
      }
    );

    return {
      videoId: extractVideoId(data),
      taskId:
        data.task_id ||
        data.id ||
        null,

      status: normalizeStatus(
        data.status || 'queued',
        Boolean(extractVideoUrl(data))
      ),

      progress:
        Number(data.progress || 0),

      videoUrl:
        extractVideoUrl(data),

      finalPrompt,
      negativePrompt:
        compiled.negativePrompt,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response?.statusText ||
      error.message;

    console.error(
      'Agnes create error:',
      details
    );

    throw new Error(
      readableAgnesError(details)
    );
  }
}

async function createImageVideoTask({
  prompt,
  imageUrl,
  qualityMode = 'high',
}) {
  const validImageUrl =
    validateImageReference(imageUrl);

  const compiled = compileVideoPrompt({
    prompt,
    hasReferenceImage: true,
    mode: qualityMode,
  });

  const consistency = buildConsistencyConfig({
    hasReferenceImage: true,
    lockCharacter: true,
    lockObjects: true,
  });

  const finalPrompt = [
    compiled.prompt,
    getConsistencyPrompt(consistency),
    buildPhysicsPrompt(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = createBasePayload(
    finalPrompt,
    compiled.negativePrompt
  );

  // Agnes v2.0 expects singular "image"
  // containing a public image URL.
  payload.image = validImageUrl;

  console.log(
    'Creating Agnes image-to-video task...'
  );

  try {
    const response = await axios.post(
      `${AGNES_BASE_URL}/v1/videos`,
      payload,
      {
        headers: getHeaders(),
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const data = response.data || {};

    console.log(
      'Agnes image create response:',
      {
        video_id: data.video_id,
        task_id: data.task_id,
        status: data.status,
      }
    );

    return {
      videoId: extractVideoId(data),

      taskId:
        data.task_id ||
        data.id ||
        null,

      status: normalizeStatus(
        data.status || 'queued',
        Boolean(extractVideoUrl(data))
      ),

      progress:
        Number(data.progress || 0),

      videoUrl:
        extractVideoUrl(data),

      finalPrompt,
      negativePrompt:
        compiled.negativePrompt,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response?.statusText ||
      error.message;

    console.error(
      'Agnes image-to-video error:',
      details
    );

    throw new Error(
      readableAgnesError(details)
    );
  }
}

async function createRetryTask({
  originalPrompt,
  attempt,
  qualityMode = 'high',
}) {
  const retryPrompt =
    buildRetryPrompt(
      originalPrompt,
      attempt
    );

  return createVideoTask({
    prompt: retryPrompt,
    qualityMode,
    hasReferenceImage: false,
  });
}

async function getVideoStatus(videoId) {
  if (!videoId) {
    throw new Error(
      'Agnes videoId is missing'
    );
  }

  try {
    const response = await axios.get(
      `${AGNES_BASE_URL}/agnesapi`,
      {
        params: {
          video_id: videoId,
          model_name: MODEL,
        },

        headers: {
          Authorization:
            `Bearer ${AGNES_API_KEY}`,
        },

        timeout: 60000,
      }
    );

    const data = response.data || {};

    const videoUrl = extractVideoUrl(data);

    return {
      videoId:
        data.video_id ||
        videoId,

      status: normalizeStatus(
        data.status,
        Boolean(videoUrl)
      ),

      rawStatus:
        data.status || null,

      progress:
        Number(data.progress || 0),

      videoUrl,

      error:
        data.error ||
        data.message ||
        null,

      raw: data,
    };
  } catch (error) {
    const details =
      error.response?.data ||
      error.response?.statusText ||
      error.message;

    throw new Error(
      readableAgnesError(details)
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
};