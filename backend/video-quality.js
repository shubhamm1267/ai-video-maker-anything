const axios = require('axios');

async function checkVideoUrl(videoUrl) {
  if (!videoUrl) {
    return {
      passed: false,
      reason: 'Video URL is missing',
    };
  }

  try {
    const response = await axios.head(videoUrl, {
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 400) {
      return {
        passed: true,
        statusCode: response.status,
        contentType:
          response.headers['content-type'] || null,
      };
    }

    return {
      passed: false,
      reason: `Video URL returned HTTP ${response.status}`,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      passed: false,
      reason: error.message || 'Unable to access video URL',
    };
  }
}

async function validateGeneratedVideo({
  videoUrl,
  expectedDuration,
}) {
  const urlCheck = await checkVideoUrl(videoUrl);

  if (!urlCheck.passed) {
    return {
      passed: false,
      stage: 'url',
      reason: urlCheck.reason,
    };
  }

  return {
    passed: true,
    stage: 'basic',
    checks: {
      videoUrl: true,
      playableUrl: true,
      expectedDuration,
    },
  };
}

module.exports = {
  checkVideoUrl,
  validateGeneratedVideo,
};