# Kya kya fix hua (v2.1)

## 1. Image → Video ke errors

### Aapka error
```
Download image URL failed: Connection reset by peer
Download image URL failed: HTTPSConnectionPool(host='...google', port=443) ... Network is unreachable
```

### Asli wajah
Agnes v2.0 image ko **khud download** karta hai — usko public image URL chahiye.

1. Purana code har uploaded image ko sirf **tmpfiles.org** par daalta tha.
   Agnes ke servers se tmpfiles kabhi-kabhi reset ho jaata hai → *Connection reset by peer*.
2. Jo URL aap type karte the, wo **bina check kiye** seedha Agnes ko chala jaata tha.
   Google Drive/Photos ke share links image file hote hi nahi, aur Agnes ke server se
   `google` reachable hi nahi hai → *Network is unreachable*.

### Ab kya hota hai (`backend/image-host.js` — naya file)
1. Drive / Dropbox / GitHub / Imgur / tmpfiles ke **share links direct file links** me convert hote hain.
2. Image ke bytes **backend khud download** karta hai aur magic-bytes se verify karta hai
   ki wo sach me image hai (HTML page nahi).
3. `sharp` se image **JPEG me re-encode + max 1536px resize** — chhoti file, har host par chalti hai.
4. Image **kai public hosts** par jaati hai, is order me:
   `PUBLIC_BASE_URL` (aapka apna server) → `imgbb` → `catbox.moe` → `0x0.st` → `tmpfiles.org`
5. Har uploaded URL ko **wapas download karke verify** kiya jaata hai. Verify na ho to skip.
6. Agnes agar phir bhi "Download image URL failed" de, to backend **automatically doosre
   host ke URL se dobara try** karta hai (`server.js` → `generateImageJob`).
7. Error message ab padhne layak hai + hint bhi aata hai (nested JSON parse ho jaata hai).

### Aap ye 2 minute ka kaam karein (recommended)
`backend/.env` me free imgbb key daal dein — iske baad image→video kabhi fail nahi hota:
```
IMGBB_API_KEY=xxxxxxxxxxxxxxxxxxxx      # https://api.imgbb.com/ (free)
```
Ya agar aapke paas ngrok/cloudflared hai:
```
PUBLIC_BASE_URL=https://abcd-12-34.ngrok-free.app
```
Tab image aapke apne backend (`/api/images/:id`) se serve hogi — sabse reliable.

---

## 2. Prompt Ideas page ke errors

**Bug:** `backend/server.js` me prompt router **mount hi nahi tha**. Isliye
`POST /api/prompt/generate` hamesha `404 API endpoint not found` deta tha.
(Purane `server.backup.js` me mount tha, naye server.js me chhut gaya.)

**Fix:** `app.use('/api/prompt', promptRouter)` wapas add kiya.

Saath me ye bhi theek kiya:
- **Fake model names hat gaye.** `gemini-3.5-flash` / `gemini-3.1-flash-lite` exist hi nahi karte the.
  Ab real names hain, aur sab fail ho to `discoverModel()` Google se **live list** maangkar
  automatic sahi model chun leta hai.
- Pehle 404 ke alawa koi bhi error aate hi loop ruk jaata tha. Ab 400/404/502 par agla model try hota hai.
- `new GoogleGenAI(...)` agar throw kare to **poora backend crash** ho jaata tha.
  Ab wo try/catch me hai aur REST fallback se page phir bhi chalta hai.
- Frontend 404 ko alag se pehchaanta hai: "Backend restart karein" wala clear message.

---

## 3. "Use for video →" button

`PromptBridgeService` prompt set to karta tha, par video page ne `bridge.take()`
kabhi call hi nahi kiya — prompt gayab ho jaata tha.
Ab `GeneratorComponent.ngOnInit()` use uthata hai.

---

## 4. Video kabhi "completed" nahi hoti thi

Backend sirf `status === 'completed'` par khatam maanta tha, par Agnes
`succeed` / `success` / `finished` / `done` bhi bhejta hai — us case me video ban chuki
hoti thi par app 5 minute tak wait karke **timeout** kar deta tha.

Ab `normalizeStatus()` in sabko `completed` maanta hai, aur video URL aa jaaye to
status kuch bhi ho, completed maana jaata hai. Timeout bhi 5 → **15 minute** (env se badal sakte hain).

---

## 5. Chhote par kaam ke fixes

| Kya | Pehle | Ab |
|---|---|---|
| API URL | har service me hard-coded `localhost:3000` | `shared/api.config.ts` — dev me localhost, build me same-origin |
| Polling | pehla status 5s baad | 1.5s baad, phir har 3s |
| Polling errors | infinite retry | 10 baar fail = clear error |
| `updateJob` | delete ho chuke job ko wapas bana deta tha | ab ignore karta hai |
| Jobs memory | kabhi clear nahi hoti thi | 6 ghante baad auto-clean |
| Status text | raw `optimizing_prompt` | "Prompt optimise ho raha hai…" |
| Image URL typing | koi feedback nahi | Drive/Photos/Instagram link par turant warning |
| Frontend build | backend serve nahi karta tha | `npm run build --prefix frontend` ke baad backend hi serve kar dega |
| 404 handler | API aur page dono ko JSON 404 | API ko JSON, baaki ko Angular index.html |

---

## Chalane ka tarika (same as before)

```
start.bat          # Windows
npm run install:all && npm run dev   # macOS / Linux
```

Check karne ke liye:
- http://localhost:3000/api/health → `gemini: true`, `imageRelay` dikhna chahiye
- http://localhost:3000/api/prompt/health → key loaded hai ya nahi
- http://localhost:3000/api/prompt/models → aapki key kaun se models use kar sakti hai

> Note: `sharp` optional hai. Agar install na ho to app phir bhi chalta hai
> (image re-encode skip ho jaata hai), par install karna behtar hai:
> `npm install --prefix backend`
