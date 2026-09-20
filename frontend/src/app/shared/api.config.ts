/**
 * Ek hi jagah se API base URL.
 *
 * Pehle har service me 'https://ai-video-maker-anything.vercel.app/api' hard-coded tha, to
 * deploy/build karne par frontend apne hi server ke bajaye localhost
 * dhoondta tha. Ab:
 *
 *  - dev (ng serve, port 4200)  -> https://ai-video-maker-anything.vercel.app/api
 *  - backend ke serve kiye hue build -> /api (same origin)
 */
function resolveApiBase(): string {
  if (typeof window === 'undefined') {
    return 'https://ai-video-maker-anything.vercel.app/api';
  }

  const { hostname, port, origin } = window.location;

  const isLocalDevServer =
    (hostname === 'localhost' || hostname === '127.0.0.1') && port === '4200';

  if (isLocalDevServer) {
    return 'https://ai-video-maker-anything.vercel.app/api';
  }

  return `${origin}/api`;
}

export const API_BASE = resolveApiBase();

export const VIDEO_API_BASE = API_BASE;

export const PROMPT_API_BASE = `${API_BASE}/prompt`;
