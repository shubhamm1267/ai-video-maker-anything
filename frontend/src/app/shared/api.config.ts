/**
 * Central API base URL.
 *
 * Frontend:
 * - Local Angular development -> Vercel backend
 * - Netlify production -> Vercel backend
 */

function resolveApiBase(): string {
  return 'https://ai-video-maker-anything.vercel.app/api';
}

export const API_BASE = resolveApiBase();

export const VIDEO_API_BASE = API_BASE;

export const PROMPT_API_BASE = `${API_BASE}/prompt`;