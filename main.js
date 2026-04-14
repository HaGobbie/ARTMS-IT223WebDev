/**
 * ARTMS — main.js  v3.4
 * Astronomical Real-Time Media System
 *
 * v3.4 Changes:
 *   1. Exponential Backoff   — fetchWithRetry() wraps every fetch call.
 *                              HTTP 500/503 auto-retries up to 3 times with
 *                              1 s → 2 s → 4 s delays before giving up.
 *   2. LocalStorage Cache    — getCachedApod / setCachedApod layer in front
 *                              of every single-date fetch. Instant loads on
 *                              repeat visits; 24 h TTL prevents stale data.
 *   3. Simpler Init          — loadLatestAvailableApod() no longer fires a
 *                              7-day range query (which caused 503s). It now
 *                              fetches today directly; falls back to yesterday
 *                              on 400 / 404 / NOT_PUBLISHED.
 *   4. Card Resilience       — Each archive card slot runs independently.
 *                              A mini tx-ring animation shows while loading.
 *                              On failure the slot retries with a different
 *                              random date up to 3 times, then shows a
 *                              "Signal Lost" placeholder card.
 *   5. Contextual Errors     — Hero error messages map to the specific HTTP
 *                              status code (404 → Not Published, 429 → Rate
 *                              Limited, 503 → NASA Server Down).
 *   6. Comment Cleanup       — All JSDoc condensed; no content removed.
 *
 * Sections:
 *   1.  Configuration & Constants
 *   2.  Module-Level State
 *   3.  Star Field Canvas Animation
 *   4.  Utility Functions
 *   5.  Cache Layer          — getCachedApod, setCachedApod
 *   6.  API Layer            — fetchWithRetry, fetchApodByDate
 *   7.  Transmission Overlay
 *   8.  Hero Viewer          — loadApodIntoHero
 *   9.  Latest Init          — loadLatestAvailableApod
 *   10. Archive Cards        — loadArchiveCards, renderArchiveCard, renderFailedCard
 *   11. Search Handler       — handleDatePickerSearch
 *   12. UI Helpers
 *   13. Event Listeners & Init
 */

// ─────────────────────────────────────────────
// 1. CONFIGURATION & CONSTANTS
// ─────────────────────────────────────────────

/** NASA API key — injected by Vite from .env at build time. Never hard-code. */
const NASA_API_KEY = import.meta.env.VITE_NASA_API_KEY;

const NASA_APOD_BASE   = "https://api.nasa.gov/planetary/apod";
const APOD_EPOCH_START = "1995-06-16";  // Hard lower bound for all date logic
const NASA_TIMEZONE    = "America/New_York"; // NASA publishes at midnight ET
const ARCHIVE_CARD_COUNT = 4;

// Retry config — applies to fetchWithRetry on HTTP 500 / 503
const RETRY_MAX_ATTEMPTS = 3;    // Total attempts: 1 original + 2 retries
const RETRY_BASE_DELAY_MS = 1000; // 1 s, then 2 s (doubles each retry)

// Cache config — localStorage key prefix + time-to-live
const CACHE_PREFIX   = "artms:apod:";
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours

// ─────────────────────────────────────────────
// 2. MODULE-LEVEL STATE
// ─────────────────────────────────────────────

/**
 * The most recently published APOD date (YYYY-MM-DD).
 * Set by loadLatestAvailableApod(). Drives the Next Day button boundary
 * and date-picker.max. Null until init resolves.
 * @type {string|null}
 */
let latestPublishedDate = null;

// ─────────────────────────────────────────────
// 3. STAR FIELD CANVAS ANIMATION
// ─────────────────────────────────────────────

/** Animated star field — runs behind the entire page. IIFE for scope isolation. */
(function initStarfield() {
  const canvas = document.getElementById("starfield");
  const ctx    = canvas.getContext("2d");
  let stars    = [];

  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };

  const createStar = () => ({
    x:       Math.random() * canvas.width,
    y:       Math.random() * canvas.height,
    radius:  Math.random() * 1.5 + 0.15,
    opacity: Math.random() * 0.7 + 0.1,
    speed:   Math.random() * 0.014 + 0.004,
    phase:   Math.random() * Math.PI * 2,
  });

  const initStars = () => { stars = Array.from({ length: 260 }, createStar); };

  const drawFrame = (ts) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach((s) => {
      const t = Math.sin(ts * s.speed + s.phase) * 0.4 + 0.6;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 220, 255, ${s.opacity * t})`;
      ctx.fill();
    });
    requestAnimationFrame(drawFrame);
  };

  resize(); initStars(); requestAnimationFrame(drawFrame);
  window.addEventListener("resize", () => { resize(); initStars(); });
})();

// ─────────────────────────────────────────────
// 4. UTILITY FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Current date in ET (America/New_York) as YYYY-MM-DD.
 * NASA publishes at midnight ET, so using the user's local clock risks
 * requesting a "tomorrow" date that hasn't been published yet.
 */
function getTodayDateString() {
  const fmt   = new Intl.DateTimeFormat("en-CA", {
    timeZone: NASA_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
}

/** YYYY-MM-DD → "Month DD, YYYY" (e.g. "July 20, 2024") */
function formatDateLabel(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "2-digit",
  });
}

/** Return the YYYY-MM-DD string for the calendar day before isoDate. */
function getPreviousDayString(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return [prev.getFullYear(), String(prev.getMonth() + 1).padStart(2, "0"), String(prev.getDate()).padStart(2, "0")].join("-");
}

/** Return the YYYY-MM-DD string for the calendar day after isoDate. */
function getNextDayString(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  return [next.getFullYear(), String(next.getMonth() + 1).padStart(2, "0"), String(next.getDate()).padStart(2, "0")].join("-");
}

/**
 * Pick a single random date in [APOD_EPOCH_START, ET today] (UTC arithmetic),
 * skipping any dates already in the excludeDates set.
 * Used by loadArchiveCards() to give each card slot a unique date to try.
 */
function getRandomSingleDate(excludeDates = new Set()) {
  const [ey, em, ed] = APOD_EPOCH_START.split("-").map(Number);
  const epochMs = Date.UTC(ey, em - 1, ed);
  const etToday = getTodayDateString();
  const [ty, tm, td] = etToday.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);

  let candidate, safety = 0;
  do {
    const d = new Date(epochMs + Math.random() * (todayMs - epochMs));
    candidate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    safety++;
  } while (
    (candidate < APOD_EPOCH_START || candidate > etToday || excludeDates.has(candidate))
    && safety < 1000
  );
  return candidate;
}

/**
 * Generate ARCHIVE_CARD_COUNT unique random dates in UTC space.
 * Used by loadArchiveCards() to seed the initial set of dates to try.
 */
function getRandomDateStrings() {
  const set = new Set();
  let safety = 0;
  while (set.size < ARCHIVE_CARD_COUNT && safety < 1000) {
    set.add(getRandomSingleDate(set));
    safety++;
  }
  return Array.from(set);
}

// ─────────────────────────────────────────────
// 5. CACHE LAYER
// ─────────────────────────────────────────────

/**
 * Return cached APOD data for dateString, or null if absent / expired / corrupt.
 * TTL is CACHE_TTL_MS (24 hours). Falls back silently if storage is unavailable.
 *
 * @param {string} dateString — YYYY-MM-DD
 * @returns {Object|null}
 */
function getCachedApod(dateString) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + dateString);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    // Expire stale entries
    if (Date.now() - timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + dateString);
      return null;
    }
    // Validate minimum required field
    if (!data?.title) return null;
    return data;
  } catch {
    return null; // JSON parse error or storage unavailable
  }
}

/**
 * Persist APOD data for dateString to localStorage with the current timestamp.
 * Silently swallows QuotaExceededError and other storage failures.
 *
 * @param {string} dateString — YYYY-MM-DD
 * @param {Object} data       — resolved APOD payload
 */
function setCachedApod(dateString, data) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + dateString,
      JSON.stringify({ data, timestamp: Date.now() })
    );
  } catch {
    // Storage full or unavailable — fail silently
  }
}

// ─────────────────────────────────────────────
// 6. API LAYER
// ─────────────────────────────────────────────

/**
 * Fetch wrapper with exponential-backoff retry for transient server errors.
 *
 * NASA's API frequently returns HTTP 500 / 503 on historical dates and
 * during high-traffic periods. This function retries those specific status
 * codes automatically before propagating the error to callers.
 *
 * Retry schedule (RETRY_MAX_ATTEMPTS = 3, RETRY_BASE_DELAY_MS = 1000):
 *   Attempt 1: immediate
 *   Attempt 2: after 1 s  (1000 × 2^0)
 *   Attempt 3: after 2 s  (1000 × 2^1)
 *
 * Non-retryable responses (400, 403, 404, 429) are returned immediately.
 * Network errors (fetch() throws) are rethrown immediately — no retry.
 *
 * @param {string} url — full request URL
 * @returns {Promise<Response>} — the final Response, successful or not
 * @throws {Error} NETWORK_ERROR on connection failure
 */
async function fetchWithRetry(url) {
  let lastResponse;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      lastResponse = await fetch(url);
    } catch {
      // fetch() only throws for network-level failures (offline, DNS, etc.)
      throw new Error(
        "NETWORK_ERROR: Unable to reach NASA servers. " +
        "Please check your internet connection and try again."
      );
    }

    const isRetryable = lastResponse.status === 500 || lastResponse.status === 503;

    // Return immediately if the response is not retryable, or we've exhausted attempts
    if (!isRetryable || attempt === RETRY_MAX_ATTEMPTS) return lastResponse;

    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.warn(`[ARTMS] HTTP ${lastResponse.status} — retry ${attempt}/${RETRY_MAX_ATTEMPTS} in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return lastResponse; // safety fallthrough (unreachable in practice)
}

/**
 * Fetch and return the APOD entry for a specific date.
 *
 * Cache strategy (checked before every network request):
 *   HIT  → return cached data immediately, no fetch
 *   MISS → fetch via fetchWithRetry, save on success
 *
 * Error taxonomy (prefix drives UI message selection in callers):
 *   "NETWORK_ERROR:"      — offline / DNS failure
 *   "AUTH_ERROR:"         — HTTP 403 — API key rejected
 *   "DATE_OUT_OF_RANGE:"  — HTTP 400 — date outside archive window
 *   "NOT_PUBLISHED:"      — HTTP 404 — date exists but image not published
 *   "RATE_LIMIT:"         — HTTP 429 — 1,000 req/hour cap exceeded
 *   "SERVER_UNAVAILABLE:" — HTTP 503 — NASA server temporarily down
 *   "SERVER_ERROR:"       — other non-2xx (500, 5xx, etc.)
 *   "EMPTY_RESPONSE:"     — 200 OK but JSON body is missing required fields
 *
 * @param {string} dateString — YYYY-MM-DD
 * @returns {Promise<Object>} — resolved APOD payload
 * @throws {Error} typed error consumed by callers
 */
async function fetchApodByDate(dateString) {
  // ── 1. Cache check — skip the network entirely if we have fresh data ────
  const cached = getCachedApod(dateString);
  if (cached) {
    console.info(`[ARTMS] Cache HIT for ${dateString}`);
    return cached;
  }

  // ── 2. Build request URL ─────────────────────────────────────────────────
  const url = new URL(NASA_APOD_BASE);
  url.searchParams.set("api_key", NASA_API_KEY);
  url.searchParams.set("date",    dateString);
  url.searchParams.set("thumbs",  "true"); // enable thumbnail_url for video entries

  // ── 3. Fetch with exponential-backoff retry (handles 500/503) ───────────
  const response = await fetchWithRetry(url.toString()); // may throw NETWORK_ERROR

  // ── 4. HTTP error classification ─────────────────────────────────────────
  if (!response.ok) {
    const s = response.status;
    if (s === 400) throw new Error(
      `DATE_OUT_OF_RANGE: No APOD entry found for ${dateString}. ` +
      `The archive begins on ${APOD_EPOCH_START} and ends at the most recently published entry.`
    );
    if (s === 403) throw new Error(
      "AUTH_ERROR: The NASA API key is invalid or has been revoked. " +
      "Verify your key at https://api.nasa.gov"
    );
    if (s === 404) throw new Error(
      `NOT_PUBLISHED: NASA has not published an image for ${dateString}. ` +
      "Try a nearby date."
    );
    if (s === 429) throw new Error(
      "RATE_LIMIT: API rate limit reached. " +
      "NASA's free tier allows 1,000 requests per hour. Please wait and try again."
    );
    if (s === 503) throw new Error(
      "SERVER_UNAVAILABLE: NASA's servers are temporarily unavailable (503). " +
      "Try again in a few minutes."
    );
    throw new Error(
      `SERVER_ERROR: NASA API returned HTTP ${s}. ` +
      "The service may be temporarily unavailable."
    );
  }

  // ── 5. Parse and validate ────────────────────────────────────────────────
  const nasaData = await response.json();
  if (!nasaData?.title) {
    throw new Error(
      "EMPTY_RESPONSE: The API returned an empty or unrecognized payload. " +
      "Please try a different date."
    );
  }

  // ── 6. Persist to cache on success ───────────────────────────────────────
  setCachedApod(dateString, nasaData);
  console.info(`[ARTMS] Cache MISS — fetched and cached ${dateString}`);

  return nasaData;
}

// ─────────────────────────────────────────────
// 7. TRANSMISSION OVERLAY
// ─────────────────────────────────────────────

/** Show the full-screen loading overlay, optionally updating the label. */
function showTransmissionOverlay(labelText = "TRANSMITTING") {
  document.getElementById("tx-label").textContent = labelText;
  const el = document.getElementById("transmission-overlay");
  el.classList.add("is-visible");
  el.setAttribute("aria-hidden", "false");
}

/** Hide the full-screen loading overlay. Always called from finally{}. */
function hideTransmissionOverlay() {
  const el = document.getElementById("transmission-overlay");
  el.classList.remove("is-visible");
  el.setAttribute("aria-hidden", "true");
}

// ─────────────────────────────────────────────
// 8. HERO VIEWER — loadApodIntoHero()
// ─────────────────────────────────────────────

/**
 * Fetch an APOD entry and update every element of the hero section in-place.
 *
 * Navigation button wiring uses nasaData.date (actual displayed date), not
 * the requested dateString. This matters when a fallback has shifted the
 * result (e.g. today→yesterday) — the Prev/Next buttons step from what is
 * shown, not what was asked for.
 *
 * Button states:
 *   hero-prev-btn  disabled  ↔  nasaData.date === APOD_EPOCH_START
 *   hero-next-btn  disabled  ↔  nasaData.date >= latestPublishedDate (or etToday)
 *
 * Contextual hero error titles/descriptions:
 *   NOT_PUBLISHED      → "Not Published Yet"     — 404
 *   RATE_LIMIT         → "Rate Limited"           — 429
 *   SERVER_UNAVAILABLE → "NASA Server Down"       — 503
 *   DATE_OUT_OF_RANGE  → "Date Out of Range"      — 400
 *   AUTH_ERROR         → "Authentication Error"   — 403
 *   NETWORK_ERROR      → "Connection Failed"
 *   others             → "Signal Lost"
 *
 * @param {string} dateString
 * @param {{ forceSourceLabel?: string|null }} [options]
 */
async function loadApodIntoHero(dateString, { forceSourceLabel = null } = {}) {
  const etToday = getTodayDateString();

  // Cache all hero element references
  const els = {
    bg:       document.getElementById("hero-bg"),
    date:     document.getElementById("hero-date"),
    srcTag:   document.getElementById("hero-source-tag"),
    title:    document.getElementById("hero-title-text"),
    exp:      document.getElementById("hero-explanation"),
    copy:     document.getElementById("hero-copyright"),
    credit:   document.getElementById("hero-credit-value"),
    version:  document.getElementById("hero-version-value"),
    download: document.getElementById("hero-download-btn"),
    strip:    document.getElementById("hero-detail-strip"),
    prevBtn:  document.getElementById("hero-prev-btn"),
    nextBtn:  document.getElementById("hero-next-btn"),
  };

  els.bg.style.opacity = "0";
  showTransmissionOverlay("ESTABLISHING LINK");

  try {
    // ── Primary fetch with today→yesterday fallback ──────────────────────
    let nasaData;
    const isToday = dateString === etToday;

    try {
      nasaData = await fetchApodByDate(dateString);
    } catch (primaryErr) {
      // If requesting today fails with a "not yet available" type error,
      // silently retry yesterday. This covers the midnight ET window before
      // NASA pushes the new image live.
      const isNotYetAvailable =
        primaryErr.message.startsWith("DATE_OUT_OF_RANGE") ||
        primaryErr.message.startsWith("NOT_PUBLISHED");

      if (isToday && isNotYetAvailable) {
        const yesterday = getPreviousDayString(etToday);
        console.info(`[ARTMS] Today (${etToday}) not yet published — trying yesterday (${yesterday})`);
        showTransmissionOverlay("LOCATING SIGNAL");
        nasaData = await fetchApodByDate(yesterday); // propagates to outer catch on failure
      } else {
        throw primaryErr;
      }
    }

    // ── Populate hero fields ─────────────────────────────────────────────
    els.date.textContent = formatDateLabel(nasaData.date);
    els.srcTag.textContent = forceSourceLabel ?? (
      nasaData.date === etToday ? "◈ Today's Picture" : "◈ Archive Entry"
    );
    els.title.textContent  = nasaData.title;
    document.title         = `ARTMS — ${nasaData.title}`;
    els.exp.textContent    = nasaData.explanation;

    const credit = nasaData.copyright
      ? nasaData.copyright.replace(/\n/g, " ").trim()
      : "NASA / JPL";
    els.copy.textContent    = `© ${credit}`;
    els.credit.textContent  = credit;
    els.version.textContent = nasaData.service_version ?? "—";
    els.strip.style.display = "";

    // Download HD button — images only
    if (nasaData.media_type === "image") {
      els.download.href          = nasaData.hdurl || nasaData.url;
      els.download.style.display = "inline-flex";
    } else {
      els.download.style.display = "none";
    }

    // ── Wire Prev / Next buttons to the actual displayed date ─────────────
    const prevDate  = getPreviousDayString(nasaData.date);
    const atEpoch   = nasaData.date <= APOD_EPOCH_START;
    els.prevBtn.disabled = atEpoch;
    els.prevBtn.onclick  = atEpoch ? null : () => loadApodIntoHero(prevDate);

    const boundary  = latestPublishedDate ?? etToday;
    const atLatest  = nasaData.date >= boundary;
    els.nextBtn.disabled = atLatest;
    if (!atLatest) {
      els.nextBtn.onclick = () => loadApodIntoHero(getNextDayString(nasaData.date));
    } else {
      els.nextBtn.onclick = null;
    }

    // ── Background image / video thumbnail ────────────────────────────────
    if (nasaData.media_type === "image") {
      const bgUrl = nasaData.hdurl || nasaData.url;
      els.bg.classList.remove("loading");
      const img = new Image();
      img.onload  = () => {
        els.bg.style.backgroundImage = `url('${bgUrl}')`;
        els.bg.style.opacity = "1";
        els.bg.setAttribute("aria-label", nasaData.title);
      };
      img.onerror = () => els.bg.classList.add("loading");
      img.src = bgUrl;
    } else if (nasaData.media_type === "video") {
      els.bg.classList.remove("loading");
      if (nasaData.thumbnail_url) {
        els.bg.style.backgroundImage = `url('${nasaData.thumbnail_url}')`;
        els.bg.style.opacity = "1";
      }
    }

    document.getElementById("hero").scrollIntoView({ behavior: "smooth", block: "start" });

  } catch (err) {
    // ── Contextual error recovery — title and body matched to error type ──
    console.warn("[ARTMS] Hero load failed:", err.message);

    const msg = err.message;

    // Map error prefix → [heroTitle, heroDescription, bannerTitle, bannerBody]
    let heroTitle, heroDesc, bannerTitle, bannerBody;

    if (msg.startsWith("NOT_PUBLISHED")) {
      heroTitle   = "Not Published Yet";
      heroDesc    = `NASA hasn't published an image for ${dateString} yet. Try a nearby date or use the date picker.`;
      bannerTitle = "Not Published";
      bannerBody  = msg.replace("NOT_PUBLISHED: ", "");
    } else if (msg.startsWith("RATE_LIMIT")) {
      heroTitle   = "Rate Limited";
      heroDesc    = "You've sent too many requests. NASA's free tier allows 1,000 per hour. Wait a moment, then try again.";
      bannerTitle = "Rate Limit Reached";
      bannerBody  = msg.replace("RATE_LIMIT: ", "");
    } else if (msg.startsWith("SERVER_UNAVAILABLE")) {
      heroTitle   = "NASA Server Down";
      heroDesc    = "NASA's servers are temporarily unavailable (503). This usually resolves within a few minutes. Try again shortly.";
      bannerTitle = "NASA Server Unavailable";
      bannerBody  = msg.replace("SERVER_UNAVAILABLE: ", "");
    } else if (msg.startsWith("DATE_OUT_OF_RANGE")) {
      heroTitle   = "Date Out of Range";
      heroDesc    = `No APOD entry exists for ${dateString}. The archive starts on ${APOD_EPOCH_START}.`;
      bannerTitle = "Date Out of Range";
      bannerBody  = msg.replace("DATE_OUT_OF_RANGE: ", "");
    } else if (msg.startsWith("AUTH_ERROR")) {
      heroTitle   = "Authentication Error";
      heroDesc    = "The NASA API key has been rejected. Check that VITE_NASA_API_KEY is set correctly in your .env file.";
      bannerTitle = "Auth Error";
      bannerBody  = msg.replace("AUTH_ERROR: ", "");
    } else if (msg.startsWith("NETWORK_ERROR")) {
      heroTitle   = "Connection Failed";
      heroDesc    = "Unable to reach NASA's servers. Please check your internet connection and try again.";
      bannerTitle = "Connection Failed";
      bannerBody  = msg.replace("NETWORK_ERROR: ", "");
    } else {
      heroTitle   = "Signal Lost";
      heroDesc    = "Could not retrieve the Astronomy Picture of the Day for this date. Please try a different date.";
      bannerTitle = "Unexpected Error";
      bannerBody  = msg.replace(/^\w+: /, "");
    }

    els.title.textContent   = heroTitle;
    els.exp.textContent     = heroDesc;
    els.date.textContent    = dateString;
    els.bg.classList.remove("loading");
    els.strip.style.display = "none";
    els.prevBtn.disabled    = true;
    els.nextBtn.disabled    = true;
    showError(bannerTitle, bannerBody);

  } finally {
    hideTransmissionOverlay();
  }
}

// ─────────────────────────────────────────────
// 9. LATEST INIT — loadLatestAvailableApod()
// ─────────────────────────────────────────────

/**
 * Discover and display the most recently published APOD entry on page load.
 *
 * Strategy (v3.4 — replaces the 7-day range query that caused 503s):
 *   1. Try fetching ET today directly.
 *   2. If today returns 400/404/NOT_PUBLISHED (image not yet live), try yesterday.
 *   3. Store the resolved date in latestPublishedDate and update date-picker.max
 *      so the UI never lets users request dates NASA hasn't published.
 *
 * If both today and yesterday fail (server outage, auth error, etc.),
 * the outer catch falls back to loadApodIntoHero(etToday) which surfaces
 * the appropriate contextual error to the user.
 */
async function loadLatestAvailableApod() {
  const etToday   = getTodayDateString();
  showTransmissionOverlay("LOCATING LATEST SIGNAL");

  try {
    let nasaData;
    let resolvedDate = etToday;

    // Attempt 1: today
    try {
      nasaData = await fetchApodByDate(etToday);
    } catch (todayErr) {
      const notAvailable =
        todayErr.message.startsWith("DATE_OUT_OF_RANGE") ||
        todayErr.message.startsWith("NOT_PUBLISHED");

      if (notAvailable) {
        // Attempt 2: yesterday — NASA hasn't pushed today's image yet
        const yesterday  = getPreviousDayString(etToday);
        resolvedDate     = yesterday;
        console.info(`[ARTMS] Init: today (${etToday}) not yet live — falling back to ${yesterday}`);
        showTransmissionOverlay("LOCATING SIGNAL");
        nasaData = await fetchApodByDate(yesterday);
      } else {
        throw todayErr; // auth, network, server errors — surface to outer catch
      }
    }

    // Store the confirmed latest date and sync the date picker max
    latestPublishedDate = nasaData.date;
    const datePickerEl  = document.getElementById("date-picker");
    datePickerEl.max    = nasaData.date;

    const sourceLabel = nasaData.date === etToday
      ? "◈ Today's Picture"
      : "◈ Latest Available";

    console.info(`[ARTMS] Init: latest published APOD is ${nasaData.date}`);
    await loadApodIntoHero(nasaData.date, { forceSourceLabel: sourceLabel });

  } catch (initErr) {
    // Both today and yesterday failed (or a non-date error occurred).
    // loadApodIntoHero will show the appropriate contextual error message.
    console.warn("[ARTMS] Init failed — handing off to hero fallback:", initErr.message);
    await loadApodIntoHero(etToday);
  } finally {
    hideTransmissionOverlay();
  }
}

// ─────────────────────────────────────────────
// 10. ARCHIVE CARDS
// ─────────────────────────────────────────────

/**
 * Load ARCHIVE_CARD_COUNT random APOD entries and populate the archive grid.
 *
 * Each card slot fetches independently:
 *   • An animated mini tx-ring spinner shows immediately while loading.
 *   • On failure, the slot retries with a different random date (up to 3 tries).
 *   • After 3 failed dates the slot shows a "Signal Lost" placeholder card.
 *
 * Dates are drawn from a shared usedDates set so every slot gets a unique date.
 * The global error banner only appears when every single slot fails.
 */
async function loadArchiveCards() {
  const grid = document.getElementById("archive-grid");
  grid.innerHTML = "";

  const usedDates = new Set(); // shared across all slots to prevent duplicate dates

  // Create all card slots immediately with mini loading spinners
  const slots = Array.from({ length: ARCHIVE_CARD_COUNT }, () => {
    const slot = document.createElement("div");
    slot.className = "skeleton-card";
    // Mini tx-ring animation inside each skeleton using the existing CSS classes.
    // Inline width/height overrides scale the rings down from their full-page size.
    slot.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:0.8rem;">
        <div style="position:relative;width:72px;height:72px;display:flex;align-items:center;justify-content:center;">
          <div class="tx-ring tx-ring--outer"  style="width:72px;height:72px;"></div>
          <div class="tx-ring tx-ring--middle" style="width:50px;height:50px;"></div>
          <div class="tx-ring tx-ring--inner"  style="width:32px;height:32px;"></div>
        </div>
        <span style="font-family:var(--font-mono);font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--clr-muted);">RETRIEVING</span>
      </div>`;
    grid.appendChild(slot);
    return slot;
  });

  // Each slot fetches independently — failures try a new random date
  const MAX_CARD_ATTEMPTS = 3;

  const promises = slots.map(async (slot) => {
    for (let attempt = 0; attempt < MAX_CARD_ATTEMPTS; attempt++) {
      const date = getRandomSingleDate(usedDates);
      usedDates.add(date); // reserve immediately before the async fetch

      try {
        const nasaData = await fetchApodByDate(date);
        slot.replaceWith(buildArchiveCard(nasaData));
        return; // success — exit the retry loop for this slot
      } catch (cardErr) {
        console.warn(
          `[ARTMS] Card slot attempt ${attempt + 1}/${MAX_CARD_ATTEMPTS} failed for ${date}:`,
          cardErr.message
        );
        if (attempt === MAX_CARD_ATTEMPTS - 1) {
          // All attempts exhausted — show a "Signal Lost" card in this slot
          slot.replaceWith(buildFailedCard());
        }
        // Otherwise loop to next attempt with a different date
      }
    }
  });

  await Promise.allSettled(promises);

  // Surface a global banner only when every slot failed
  const realCards = grid.querySelectorAll(".archive-card:not(.card-failed)").length;
  if (realCards === 0) {
    showError(
      "Archive Unavailable",
      "Could not load any archive entries. Please check your connection and try shuffling again."
    );
  }
}

/**
 * Build a full-detail archive card element.
 * Returns the element — caller is responsible for inserting it into the DOM.
 *
 * Card sections:
 *   • Thumbnail / video placeholder  (with date chip overlay)
 *   • Title + scrollable explanation (no line-clamping)
 *   • Metadata row: Credit, Service Version
 *   • Actions: "▶ View Full Entry" (updates hero in-place) + "⬇ HD" download
 *
 * Whole card is keyboard-accessible (role=button, tabIndex=0, Enter/Space).
 *
 * @param {Object} nasaData — resolved APOD payload
 * @returns {HTMLElement}
 */
function buildArchiveCard(nasaData) {
  const card = document.createElement("article");
  card.className = "archive-card";
  card.tabIndex  = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `View full entry: ${nasaData.title}, ${nasaData.date}`);

  // Thumbnail
  const imgWrap = document.createElement("div");
  imgWrap.className = "card-image-wrapper";

  if (nasaData.media_type === "image") {
    const img   = document.createElement("img");
    img.src     = nasaData.url;
    img.alt     = nasaData.title;
    img.loading = "lazy";
    img.onerror = () => {
      img.style.display = "none";
      imgWrap.style.background = "linear-gradient(135deg, var(--clr-deep), var(--clr-nasa))";
    };
    imgWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "card-video-placeholder";
    ph.innerHTML = `<span class="play-icon">▶</span><span class="video-label">Video Entry</span>`;
    if (nasaData.thumbnail_url) {
      imgWrap.style.cssText = `background:url('${nasaData.thumbnail_url}') center/cover no-repeat`;
    }
    imgWrap.appendChild(ph);
  }

  const chip = document.createElement("span");
  chip.className   = "card-date-chip";
  chip.textContent = nasaData.date;
  imgWrap.appendChild(chip);

  // Body
  const body = document.createElement("div");
  body.className = "card-body";

  const titleEl = document.createElement("h3");
  titleEl.className   = "card-title";
  titleEl.textContent = nasaData.title;

  const divider = document.createElement("div");
  divider.className = "card-divider";

  const expEl = document.createElement("p");
  expEl.className   = "card-explanation";
  expEl.textContent = nasaData.explanation;

  body.appendChild(titleEl);
  body.appendChild(divider);
  body.appendChild(expEl);

  // Metadata
  const meta = document.createElement("div");
  meta.className = "card-meta-row";
  meta.innerHTML = `
    <div class="card-meta-item">
      <span class="card-meta-item__label">Credit</span>
      <span class="card-meta-item__value">${
        nasaData.copyright ? nasaData.copyright.replace(/\n/g, " ").trim() : "NASA / JPL"
      }</span>
    </div>
    <div class="card-meta-item">
      <span class="card-meta-item__label">Service Version</span>
      <span class="card-meta-item__value">${nasaData.service_version ?? "—"}</span>
    </div>`;

  // Actions
  const actions = document.createElement("div");
  actions.className = "card-actions";

  const viewBtn = document.createElement("button");
  viewBtn.className   = "btn-view-in-hero";
  viewBtn.textContent = "▶  View Full Entry";
  viewBtn.setAttribute("aria-label", `Load ${nasaData.title} into the hero viewer`);
  viewBtn.addEventListener("click", (e) => { e.stopPropagation(); loadApodIntoHero(nasaData.date); });
  actions.appendChild(viewBtn);

  if (nasaData.media_type === "image" && (nasaData.hdurl || nasaData.url)) {
    const dl = document.createElement("a");
    dl.className   = "btn-download";
    dl.href        = nasaData.hdurl || nasaData.url;
    dl.target      = "_blank";
    dl.rel         = "noopener";
    dl.textContent = "⬇ HD";
    dl.setAttribute("aria-label", `Download HD: ${nasaData.title}`);
    dl.addEventListener("click", (e) => e.stopPropagation());
    actions.appendChild(dl);
  }

  // Assemble
  card.appendChild(imgWrap);
  card.appendChild(body);
  card.appendChild(meta);
  card.appendChild(actions);

  card.addEventListener("click", () => loadApodIntoHero(nasaData.date));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); loadApodIntoHero(nasaData.date); }
  });

  return card;
}

/**
 * Build a "Signal Lost" placeholder card for when all retry attempts fail.
 * Reuses .archive-card so it slots into the grid without layout shifts,
 * plus a .card-failed marker for the "all slots failed" detection check.
 *
 * @returns {HTMLElement}
 */
function buildFailedCard() {
  const card = document.createElement("article");
  card.className = "archive-card card-failed";
  card.setAttribute("aria-label", "Failed to load archive entry");
  card.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;padding:2rem;text-align:center;gap:1rem;min-height:320px;">
      <span style="font-size:2.2rem;opacity:0.25;">⚠</span>
      <span style="font-family:var(--font-display);font-size:1.4rem;letter-spacing:0.06em;color:var(--clr-muted);">Signal Lost</span>
      <span style="font-family:var(--font-mono);font-size:0.62rem;color:var(--clr-muted);opacity:0.55;line-height:1.6;">
        Could not load an entry<br/>after 3 attempts
      </span>
    </div>`;
  return card;
}

// ─────────────────────────────────────────────
// 11. SEARCH HANDLER
// ─────────────────────────────────────────────

/**
 * Handle the "JUMP TO DATE" button click.
 * Validates against the ET-synchronised today (and latestPublishedDate if known)
 * before calling loadApodIntoHero() in-place.
 */
async function handleDatePickerSearch() {
  const datePickerEl = document.getElementById("date-picker");
  const selected     = datePickerEl.value;

  if (!selected) {
    showError("No Date Selected", "Please pick a date using the calendar before jumping.");
    return;
  }

  const etToday    = getTodayDateString();
  const upperBound = latestPublishedDate ?? etToday; // use confirmed latest when known

  if (selected > upperBound) {
    showError(
      "Future Date Selected",
      "The APOD archive only contains entries up to the most recently published date. " +
      "Please choose a past date."
    );
    return;
  }

  if (selected < APOD_EPOCH_START) {
    showError(
      "Date Too Early",
      `The APOD archive begins on ${APOD_EPOCH_START}. Please select a more recent date.`
    );
    return;
  }

  clearError();
  setSearchLoading(true);
  try {
    await loadApodIntoHero(selected);
  } finally {
    setSearchLoading(false);
  }
}

// ─────────────────────────────────────────────
// 12. UI HELPERS
// ─────────────────────────────────────────────

/** Toggle the search button and date picker between idle and loading states. */
function setSearchLoading(isLoading) {
  const btn    = document.getElementById("search-btn");
  const label  = document.getElementById("btn-label");
  const picker = document.getElementById("date-picker");
  if (isLoading) {
    label.innerHTML   = `<span class="spin"></span> LOADING`;
    btn.disabled      = true;
    picker.disabled   = true;
  } else {
    label.innerHTML   = "JUMP TO DATE";
    btn.disabled      = false;
    picker.disabled   = false;
  }
}

/** Show the error banner and scroll it into view. */
function showError(title, body) {
  const banner = document.getElementById("error-banner");
  document.getElementById("error-title").textContent = `⚠ ${title}`;
  document.getElementById("error-body").textContent  = body;
  banner.classList.add("visible");
  banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Hide the error banner. */
function clearError() {
  document.getElementById("error-banner").classList.remove("visible");
}

// ─────────────────────────────────────────────
// 13. EVENT LISTENERS & INIT
// ─────────────────────────────────────────────

document.getElementById("search-btn").addEventListener("click", handleDatePickerSearch);
document.getElementById("date-picker").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleDatePickerSearch();
});
document.getElementById("error-close").addEventListener("click", clearError);
document.getElementById("nav-shuffle-btn").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("archive-section").scrollIntoView({ behavior: "smooth" });
  loadArchiveCards();
});
document.getElementById("shuffle-btn").addEventListener("click", loadArchiveCards);

// Set date picker bounds — max tightened to latestPublishedDate once init resolves
const datePickerEl = document.getElementById("date-picker");
datePickerEl.max   = getTodayDateString();
datePickerEl.min   = APOD_EPOCH_START;

// Page init — run in parallel; neither blocks the other
loadLatestAvailableApod();
loadArchiveCards();
