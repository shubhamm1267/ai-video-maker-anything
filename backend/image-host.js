'use strict';

/*
 * image-host.js
 * -----------------------------------------------------------
 * Agnes v2.0 ka image-to-video endpoint sirf ek PUBLIC image
 * URL accept karta hai. Agnes ka server khud us URL ko download
 * karta hai.
 *
 * Purane code ki 2 badi galtiyan thin:
 *
 *  1. Sirf tmpfiles.org par upload hota tha. Agnes ke servers se
 *     tmpfiles kabhi kabhi block/reset ho jaata hai:
 *       "Download image URL failed: Connection reset by peer"
 *
 *  2. User ka diya hua URL bina check kiye seedha Agnes ko chala
 *     jaata tha. Google Drive / Dropbox ke "share" links image
 *     file nahi hote, aur Agnes ke server se google.com reachable
 *     hi nahi hai:
 *       "Failed to establish a new connection: Network is unreachable"
 *
 * Ab ka flow:
 *
 *   data URL / user URL
 *        -> share link ko direct-download link me normalize karo
 *        -> bytes backend par khud download karo (verify: sach me image hai?)
 *        -> sharp se JPEG me re-encode + resize (chhota, safe, universal)
 *        -> kai public hosts par upload karo (fallback chain)
 *        -> har uploaded URL ko wapas download karke VERIFY karo
 *        -> candidate URLs ki list return karo
 *
 * server.js in candidates ko ek ek karke Agnes ko deta hai, to ek
 * host fail ho to bhi video ban jaati hai.
 */

const crypto = require('crypto');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  // sharp optional hai - na mile to raw bytes bhej denge.
  sharp = null;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB input limit
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // hosts ke liye target
const MAX_DIMENSION = 1536;
const DOWNLOAD_TIMEOUT = 45000;
const UPLOAD_TIMEOUT = 60000;
const VERIFY_TIMEOUT = 25000;

/* In-memory store: PUBLIC_BASE_URL set ho to hum khud image serve karte hain. */
const imageStore = new Map();
const STORE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function putImageInStore(buffer, mimeType, extension) {
  const id = `${Date.now().toString(36)}-${crypto
    .randomBytes(6)
    .toString('hex')}.${extension}`;

  imageStore.set(id, {
    buffer,
    mimeType,
    createdAt: Date.now(),
  });

  cleanupStore();
  return id;
}

function getImageFromStore(id) {
  const entry = imageStore.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > STORE_TTL) {
    imageStore.delete(id);
    return null;
  }
  return entry;
}

function cleanupStore() {
  const now = Date.now();
  for (const [id, entry] of imageStore) {
    if (now - entry.createdAt > STORE_TTL) imageStore.delete(id);
  }
}

/* --------------------------------------------------
   1. SHARE LINKS -> DIRECT IMAGE LINKS
-------------------------------------------------- */

/**
 * Google Drive / Dropbox / OneDrive / GitHub / Imgur ke "page"
 * links ko real file links me badalta hai.
 */
function normalizeImageUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return url;

  // Google Drive: /file/d/<ID>/view  ya  ?id=<ID>
  const driveFile = url.match(
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/
  );
  if (driveFile) {
    return `https://drive.google.com/uc?export=download&id=${driveFile[1]}`;
  }

  const driveOpen = url.match(
    /drive\.google\.com\/(?:open|uc)\?[^ ]*id=([a-zA-Z0-9_-]+)/
  );
  if (driveOpen) {
    return `https://drive.google.com/uc?export=download&id=${driveOpen[1]}`;
  }

  // Google Photos / photos.app.goo.gl short links: direct file nahi milta.
  // In par hum kuch nahi kar sakte - caller friendly error dega.

  // Dropbox: ?dl=0 -> ?raw=1
  if (/dropbox\.com/i.test(url)) {
    url = url.replace(/([?&])dl=0/i, '$1raw=1');
    if (!/[?&]raw=1/i.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'raw=1';
    }
    return url;
  }

  // GitHub blob -> raw
  const ghBlob = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i
  );
  if (ghBlob) {
    return `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;
  }

  // Imgur page -> direct jpeg
  const imgurPage = url.match(
    /^https?:\/\/(?:www\.)?imgur\.com\/(?:gallery\/)?([a-zA-Z0-9]+)$/i
  );
  if (imgurPage) {
    return `https://i.imgur.com/${imgurPage[1]}.jpeg`;
  }

  // tmpfiles page -> direct download
  if (/^https?:\/\/tmpfiles\.org\/(?!dl\/)/i.test(url)) {
    return url.replace(
      /^https?:\/\/tmpfiles\.org\//i,
      'https://tmpfiles.org/dl/'
    );
  }

  return url;
}

/** Aise links jinse kabhi image bytes nahi milte. */
function unsupportedUrlReason(url) {
  if (/photos\.app\.goo\.gl|photos\.google\.com/i.test(url)) {
    return 'Google Photos ke share links se image download nahi hoti. Image ko download karke "Upload Image" se bhejein.';
  }
  if (/docs\.google\.com\/document|\/spreadsheets\//i.test(url)) {
    return 'Yeh ek Google Docs/Sheets link hai, image file nahi.';
  }
  return null;
}

/* --------------------------------------------------
   2. BYTES NIKALO (data URL ya remote URL se)
-------------------------------------------------- */

const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif|bmp));base64,(.+)$/i;

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(DATA_URL_RE);
  if (!match) {
    throw new Error(
      'Sirf PNG, JPG, JPEG, WEBP images support hoti hain.'
    );
  }

  let mimeType = match[1].toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length) {
    throw new Error('Image data khali hai (corrupt file).');
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image bahut badi hai. Maximum 12 MB.');
  }

  return { buffer, mimeType };
}

/** Magic bytes se check karo ki yeh sach me image hai. */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'image/png';
  }
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, timeout = DOWNLOAD_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url) {
  const blocked = unsupportedUrlReason(url);
  if (blocked) throw new Error(blocked);

  let response;
  try {
    response = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: {
        // Kuch hosts bina browser UA ke block kar dete hain.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
  } catch (error) {
    throw new Error(
      `Is image URL se download nahi ho paaya (${
        error.name === 'AbortError' ? 'timeout' : error.message
      }). URL public hona chahiye.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Image URL ne HTTP ${response.status} diya. URL public/direct image link hona chahiye.`
    );
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('text/html')) {
    throw new Error(
      'Yeh URL ek web page hai, image file nahi. Image par right-click -> "Copy image address" karke wahi link daalein.'
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image bahut badi hai. Maximum 12 MB.');
  }

  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    throw new Error(
      'Is URL par valid image file nahi mili (PNG/JPG/WEBP expected).'
    );
  }

  return { buffer, mimeType: sniffed };
}

/* --------------------------------------------------
   3. NORMALISE (sharp)
-------------------------------------------------- */

/**
 * Har image ko ek safe JPEG me badal do:
 * chhoti file = upload fast + hosts/Agnes dono khush.
 */
async function normalizeImageBuffer(buffer, mimeType) {
  if (!sharp) {
    return {
      buffer,
      mimeType,
      extension: mimeType === 'image/png' ? 'png' : 'jpg',
    };
  }

  try {
    let quality = 88;
    let out = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    while (out.length > MAX_UPLOAD_BYTES && quality > 55) {
      quality -= 10;
      out = await sharp(buffer)
        .rotate()
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    }

    return { buffer: out, mimeType: 'image/jpeg', extension: 'jpg' };
  } catch (error) {
    console.warn(
      '[image] sharp se re-encode fail hua, original bytes use kar rahe hain:',
      error.message
    );
    return {
      buffer,
      mimeType,
      extension: mimeType === 'image/png' ? 'png' : 'jpg',
    };
  }
}

/* --------------------------------------------------
   4. PUBLIC HOSTS (fallback chain)
-------------------------------------------------- */

async function uploadToCatbox({ buffer, mimeType, extension }) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append(
    'fileToUpload',
    new Blob([buffer], { type: mimeType }),
    `reference.${extension}`
  );

  const response = await fetchWithTimeout(
    'https://catbox.moe/user/api.php',
    { method: 'POST', body: form },
    UPLOAD_TIMEOUT
  );

  const text = (await response.text()).trim();

  if (!response.ok || !/^https?:\/\//i.test(text)) {
    throw new Error(`catbox ne galat jawab diya: ${text.slice(0, 120)}`);
  }
  return text;
}

async function uploadToTmpfiles({ buffer, mimeType, extension }) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: mimeType }),
    `reference.${extension}`
  );

  const response = await fetchWithTimeout(
    'https://tmpfiles.org/api/v1/upload',
    { method: 'POST', body: form },
    UPLOAD_TIMEOUT
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`tmpfiles HTTP ${response.status}: ${text.slice(0, 120)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`tmpfiles ne JSON nahi diya: ${text.slice(0, 120)}`);
  }

  const pageUrl = data?.data?.url;
  if (!pageUrl) throw new Error('tmpfiles ne URL nahi diya');

  return pageUrl.replace(
    /^https?:\/\/tmpfiles\.org\//i,
    'https://tmpfiles.org/dl/'
  );
}

async function uploadToZeroXZero({ buffer, mimeType, extension }) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: mimeType }),
    `reference.${extension}`
  );

  const response = await fetchWithTimeout(
    'https://0x0.st',
    {
      method: 'POST',
      body: form,
      headers: {
        'User-Agent': 'text-to-video-app/2.0 (image relay)',
      },
    },
    UPLOAD_TIMEOUT
  );

  const text = (await response.text()).trim();
  if (!response.ok || !/^https?:\/\//i.test(text)) {
    throw new Error(`0x0.st ne galat jawab diya: ${text.slice(0, 120)}`);
  }
  return text;
}

async function uploadToImgbb({ buffer }) {
  const key = (process.env.IMGBB_API_KEY || '').trim();
  if (!key) throw new Error('IMGBB_API_KEY set nahi hai');

  const form = new FormData();
  form.append('image', buffer.toString('base64'));
  form.append('expiration', '21600');

  const response = await fetchWithTimeout(
    `https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`,
    { method: 'POST', body: form },
    UPLOAD_TIMEOUT
  );

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`imgbb ne JSON nahi diya: ${text.slice(0, 120)}`);
  }

  const url = data?.data?.url || data?.data?.display_url;
  if (!response.ok || !url) {
    throw new Error(
      `imgbb upload fail: ${data?.error?.message || `HTTP ${response.status}`}`
    );
  }
  return url;
}

/** PUBLIC_BASE_URL (ngrok / cloudflare tunnel / deployed server) */
function hostOnThisServer({ buffer, mimeType, extension }) {
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('PUBLIC_BASE_URL set nahi hai');
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    throw new Error(
      'PUBLIC_BASE_URL localhost hai - Agnes usko internet se access nahi kar sakta'
    );
  }

  const id = putImageInStore(buffer, mimeType, extension);
  return `${base}/api/images/${id}`;
}

/*
 * Order matters. Sabse reliable pehle.
 * imgbb aur own-server tabhi chalte hain jab configure ho.
 */
const HOSTS = [
  { name: 'this-server', upload: async (img) => hostOnThisServer(img) },
  { name: 'imgbb', upload: uploadToImgbb },
  { name: 'catbox.moe', upload: uploadToCatbox },
  { name: '0x0.st', upload: uploadToZeroXZero },
  { name: 'tmpfiles.org', upload: uploadToTmpfiles },
];

/* --------------------------------------------------
   5. VERIFY: kya yeh URL sach me public hai?
-------------------------------------------------- */

async function verifyPublicUrl(url) {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; text-to-video-app/2.0)',
          Accept: 'image/*,*/*;q=0.8',
        },
      },
      VERIFY_TIMEOUT
    );

    if (!response.ok) return false;

    const buffer = Buffer.from(await response.arrayBuffer());
    return Boolean(sniffImageType(buffer));
  } catch {
    return false;
  }
}

/* --------------------------------------------------
   6. PUBLIC API
-------------------------------------------------- */

/**
 * Image (upload ya URL) ko Agnes ke liye ready public URLs me badalta hai.
 *
 * @returns {Promise<{candidates: {url: string, host: string}[], notes: string[]}>}
 */
async function buildPublicImageUrls({ imageData, imageUrl }) {
  const notes = [];
  let source;

  if (imageData) {
    source = parseDataUrl(imageData);
    notes.push('Uploaded/pasted image use ho rahi hai.');
  } else if (imageUrl) {
    const normalized = normalizeImageUrl(imageUrl);

    if (normalized !== imageUrl.trim()) {
      notes.push(`Share link ko direct link me badla: ${normalized}`);
    }

    try {
      source = await downloadImage(normalized);
      notes.push('Image URL se bytes download ho gaye.');
    } catch (error) {
      /*
       * Hum download nahi kar paaye. Ho sakta hai host humein block
       * kare par Agnes ko na kare - isliye original URL ko aakhri
       * candidate ke taur par rakhte hain, lekin error bhi batate hain.
       */
      notes.push(`Direct download fail: ${error.message}`);
      return {
        candidates: [{ url: normalized, host: 'original-url (unverified)' }],
        notes,
        downloadError: error.message,
      };
    }
  } else {
    throw new Error(
      'Image upload karein / Ctrl+V se paste karein ya image URL daalein.'
    );
  }

  const normalizedImage = await normalizeImageBuffer(
    source.buffer,
    source.mimeType
  );

  notes.push(
    `Image normalise ho gayi: ${normalizedImage.mimeType}, ${(
      normalizedImage.buffer.length / 1024
    ).toFixed(0)} KB`
  );

  const candidates = [];

  for (const host of HOSTS) {
    try {
      const url = await host.upload(normalizedImage);

      const ok = await verifyPublicUrl(url);
      if (!ok) {
        notes.push(`${host.name}: upload hua par URL verify nahi hua, skip.`);
        continue;
      }

      notes.push(`${host.name}: OK -> ${url}`);
      candidates.push({ url, host: host.name });

      // 2 verified candidates kaafi hain (fallback ke liye).
      if (candidates.length >= 2) break;
    } catch (error) {
      notes.push(`${host.name}: ${error.message}`);
    }
  }

  if (!candidates.length) {
    throw new Error(
      'Image ko kisi bhi public host par upload nahi kar paaye. Internet/firewall check karein, ya backend/.env me IMGBB_API_KEY daalein (https://api.imgbb.com/ se free key milti hai).'
    );
  }

  return { candidates, notes };
}

module.exports = {
  buildPublicImageUrls,
  normalizeImageUrl,
  unsupportedUrlReason,
  parseDataUrl,
  sniffImageType,
  getImageFromStore,
  MAX_IMAGE_BYTES,
};
