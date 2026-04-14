/**
 * ARTMS — main.js  v3.3
 * Astronomical Real-Time Media System
 *
 * Architecture:
 *   - The HERO is the full APOD viewer. On load it shows the most recently
 *     published entry, discovered via a 7-day range query. Archive card clicks
 *     and the date picker both update the hero in-place with no page reload.
 *   - The ARCHIVE SECTION shows 4 random APOD cards on page load, each
 *     clickable to update the hero.
 *   - All navigation is in-app. Zero external redirects.
 *
 * v3.3 Fixes:
 *
 *   1. UTC-BASED SHUFFLE (getRandomDateStrings)
 *      The previous implementation used new Date(ms) and read LOCAL date
 *      parts (.getFullYear etc.), which shifted the date one day backward
 *      in negative-UTC-offset zones, sometimes producing dates before
 *      APOD_EPOCH_START. The fix: parse both bounds with Date.UTC() and
 *      read back with .getUTCFullYear() / .getUTCMonth() / .getUTCDate()
 *      so the entire calculation stays in UTC space. A hard clamp
 *      (candidate >= APOD_EPOCH_START && candidate <= etToday) and a
 *      safetyCounter catch any remaining edge cases.
 *
 *   2. RANGE-BASED INIT (loadLatestAvailableApod)
 *      Instead of guessing today's date and falling back once, this function
 *      queries the NASA API for the last 7 days using start_date / end_date.
 *      The last element of the sorted array is definitively the most-recently
 *      published entry. This date is stored in latestPublishedDate and used
 *      to update date-picker.max, so the UI never allows users to select
 *      dates NASA has not yet published.
 *
 *   3. NEXT DAY BUTTON WITH BOUNDARY AWARENESS
 *      loadApodIntoHero() now wires both hero-prev-btn and hero-next-btn on
 *      every successful load, using nasaData.date (the actual displayed date)
 *      rather than the requested dateString. hero-next-btn is disabled when
 *      nasaData.date >= latestPublishedDate, preventing requests into the
 *      unpublished future. hero-prev-btn disables at APOD_EPOCH_START.
 *
 * Sections:
 *   1.  Configuration & Constants
 *   2.  Module-Level State
 *   3.  Star Field Canvas Animation
 *   4.  Utility Functions        ← UTC fix in getRandomDateStrings
 *   5.  API Layer                — fetchApodByDate(), fetchApodRange()
 *   6.  Transmission Overlay     — showTransmissionOverlay(), hideTransmissionOverlay()
 *   7.  Hero Viewer              — loadApodIntoHero()
 *   8.  Latest Init              — loadLatestAvailableApod()   ← new
 *   9.  Archive Cards            — loadArchiveCards(), renderArchiveCard()
 *   10. Search Handler           — handleDatePickerSearch()
 *   11. UI Helpers               — showError(), clearError(), setSearchLoading()
 *   12. Event Listeners & Init
 */

// ─────────────────────────────────────────────
// 1. CONFIGURATION & CONSTANTS
// ─────────────────────────────────────────────

/**
 * NASA API key — injected by Vite from .env at build time.
 * The VITE_ prefix is mandatory; Vite strips variables without it
 * to prevent server-side secrets from reaching the browser bundle.
 *
 * Store in .env only. Never commit .env to version control.
 * @see https://vitejs.dev/guide/env-and-mode
 */
const NASA_API_KEY = import.meta.env.VITE_NASA_API_KEY;

/** NASA APOD REST endpoint */
const NASA_APOD_BASE = "https://api.nasa.gov/planetary/apod";

/** Earliest date in the APOD archive — used as the hard lower bound everywhere */
const APOD_EPOCH_START = "1995-06-16";

/**
 * IANA timezone for NASA's publish clock.
 * A new APOD goes live at midnight Eastern Time, so every "today"
 * calculation must use this zone rather than the user's local clock.
 */
const NASA_TIMEZONE = "America/New_York";

/**
 * Number of random archive cards to display.
 * Changing this constant automatically adjusts the grid.
 */
const ARCHIVE_CARD_COUNT = 4;

/**
 * Width of the look-back window used by loadLatestAvailableApod().
 * 7 days is wide enough to always capture the latest published entry
 * even during holidays or NASA maintenance periods.
 */
const LATEST_LOOKBACK_DAYS = 7;

// ─────────────────────────────────────────────
// 2. MODULE-LEVEL STATE
// ─────────────────────────────────────────────

/**
 * The most recently published APOD date, expressed as a YYYY-MM-DD string.
 * Set by loadLatestAvailableApod() after the range query succeeds.
 * Falls back to the ET today string when the range query has not yet resolved.
 *
 * Used by loadApodIntoHero() to decide whether hero-next-btn should be
 * disabled — the button is disabled when the active entry equals this date.
 *
 * @type {string | null}
 */
let latestPublishedDate = null;

// ─────────────────────────────────────────────
// 3. STAR FIELD CANVAS ANIMATION
// ─────────────────────────────────────────────

/**
 * Initialise and animate the fixed star field canvas behind the page.
 * Each star twinkles via a per-star sine-wave opacity oscillation per frame.
 * Wrapped in an IIFE to isolate all internal state from the module scope.
 */
(function initStarfield() {
  const canvas     = document.getElementById("starfield");
  const ctx        = canvas.getContext("2d");
  const STAR_COUNT = 260;
  let   stars      = [];

  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function createStar() {
    return {
      x:       Math.random() * canvas.width,
      y:       Math.random() * canvas.height,
      radius:  Math.random() * 1.5 + 0.15,
      opacity: Math.random() * 0.7 + 0.1,
      speed:   Math.random() * 0.014 + 0.004,
      phase:   Math.random() * Math.PI * 2,
    };
  }

  function initStars() {
    stars = Array.from({ length: STAR_COUNT }, createStar);
  }

  function drawFrame(timestamp) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach((star) => {
      const twinkle = Math.sin(timestamp * star.speed + star.phase) * 0.4 + 0.6;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 220, 255, ${star.opacity * twinkle})`;
      ctx.fill();
    });
    requestAnimationFrame(drawFrame);
  }

  resizeCanvas();
  initStars();
  requestAnimationFrame(drawFrame);
  window.addEventListener("resize", () => { resizeCanvas(); initStars(); });
})();

// ─────────────────────────────────────────────
// 4. UTILITY FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Return the current date as a YYYY-MM-DD string resolved in Eastern Time (ET).
 *
 * WHY ET?
 * NASA publishes a new APOD at midnight Eastern Time. Users in timezones ahead
 * of ET (e.g. UTC+8, UTC+5:30) may already be on "tomorrow" locally while
 * NASA's server is still on "today". Requesting that future date gives a 400
 * DATE_OUT_OF_RANGE error. Using ET keeps requests in sync with the server.
 *
 * Intl.DateTimeFormat with timeZone: "America/New_York" handles EST/EDT
 * switching automatically via the IANA timezone database — no manual DST math.
 * The "en-CA" locale produces YYYY-MM-DD parts natively, so individual
 * formatToParts() values are already zero-padded and correctly ordered.
 *
 * @returns {string}  e.g. "2025-07-20"
 */
function getTodayDateString() {
  const etFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: NASA_TIMEZONE,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  });
  const parts = etFormatter.formatToParts(new Date());
  const yyyy  = parts.find((p) => p.type === "year").value;
  const mm    = parts.find((p) => p.type === "month").value;
  const dd    = parts.find((p) => p.type === "day").value;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a YYYY-MM-DD string into a human-readable long label.
 * e.g. "2024-07-20" → "July 20, 2024"
 *
 * Explicit year/month/day avoids the UTC-midnight-parsing ambiguity that
 * occurs when passing an ISO string directly to the Date constructor.
 *
 * @param {string} isoDate
 * @returns {string}
 */
function formatDateLabel(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "2-digit",
  });
}

/**
 * Return the YYYY-MM-DD string for the day before isoDate.
 * Arithmetic uses local-calendar space (new Date(y, m-1, d-1)) which is
 * correct for calendar-date subtraction — the result is always a past date
 * so no ET conversion is required.
 *
 * @param {string} isoDate
 * @returns {string}
 */
function getPreviousDayString(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const prev = new Date(year, month - 1, day - 1);
  return [
    prev.getFullYear(),
    String(prev.getMonth() + 1).padStart(2, "0"),
    String(prev.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Return the YYYY-MM-DD string for the day after isoDate.
 * Used by the Next Day button in the hero strip.
 * The caller is responsible for ensuring the result does not exceed
 * latestPublishedDate before invoking a fetch.
 *
 * @param {string} isoDate
 * @returns {string}
 */
function getNextDayString(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(year, month - 1, day + 1);
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Generate ARCHIVE_CARD_COUNT unique random YYYY-MM-DD date strings,
 * each falling within [APOD_EPOCH_START, ET today].
 *
 * FIX (v3.3) — UTC-based arithmetic:
 * The previous version used new Date(randomMs) and read LOCAL date parts
 * (.getFullYear / .getMonth / .getDate). In timezones behind UTC (negative
 * offsets), UTC midnight is still "yesterday" locally, which occasionally
 * shifted dates before APOD_EPOCH_START and produced 400 errors.
 *
 * The fix has three parts:
 *   1. Parse both bounds with Date.UTC() so epochMs and todayMs represent
 *      UTC midnight on the correct calendar dates.
 *   2. Read date parts back with .getUTCFullYear() / .getUTCMonth() /
 *      .getUTCDate() so the UTC timestamp is interpreted correctly.
 *   3. Hard clamp: reject any candidate outside [APOD_EPOCH_START, etToday]
 *      as a safety net for any remaining floating-point edge case.
 *      A safetyCounter prevents an infinite loop if the window collapses.
 *
 * @returns {string[]}  Array of unique YYYY-MM-DD strings
 */
function getRandomDateStrings() {
  // Parse APOD_EPOCH_START as UTC midnight — consistent with how the
  // APOD API treats date strings (they are calendar dates, not instants)
  const [ey, em, ed] = APOD_EPOCH_START.split("-").map(Number);
  const epochUtcMs   = Date.UTC(ey, em - 1, ed);

  // Use the ET-synchronised today as the upper bound, also parsed as UTC
  const etToday      = getTodayDateString();
  const [ty, tm, td] = etToday.split("-").map(Number);
  const todayUtcMs   = Date.UTC(ty, tm - 1, td);

  const dates        = new Set();
  let   safetyCounter = 0; // prevents infinite loop in degenerate cases

  while (dates.size < ARCHIVE_CARD_COUNT && safetyCounter < 1000) {
    safetyCounter++;

    // Pick a random UTC millisecond within the archive window
    const randomUtcMs = epochUtcMs + Math.random() * (todayUtcMs - epochUtcMs);
    const randomDate  = new Date(randomUtcMs);

    // Read UTC date parts — avoids local-timezone shifting the calendar date
    const yyyy = randomDate.getUTCFullYear();
    const mm   = String(randomDate.getUTCMonth() + 1).padStart(2, "0");
    const dd   = String(randomDate.getUTCDate()).padStart(2, "0");
    const candidate = `${yyyy}-${mm}-${dd}`;

    // Hard clamp: accept only dates within the valid archive window
    if (candidate >= APOD_EPOCH_START && candidate <= etToday) {
      dates.add(candidate);
    }
  }

  return Array.from(dates);
}

// ─────────────────────────────────────────────
// 5. API LAYER
// ─────────────────────────────────────────────

/**
 * Fetch the APOD entry for a single date from NASA's Open API.
 *
 * This function is intentionally single-purpose — it fetches exactly the
 * date it is given and throws a typed error on any failure. Retry logic
 * and fallback behaviour live exclusively in loadApodIntoHero() and
 * loadLatestAvailableApod() so the API layer stays cohesive.
 *
 * Error taxonomy (prefix drives UI message selection in callers):
 *   "NETWORK_ERROR:"      — fetch() threw (offline / DNS failure)
 *   "DATE_OUT_OF_RANGE:"  — HTTP 400: date outside the published archive
 *   "AUTH_ERROR:"         — HTTP 403: API key rejected
 *   "RATE_LIMIT:"         — HTTP 429: 1,000 req/hour cap exceeded
 *   "SERVER_ERROR:"       — any other non-2xx status
 *   "EMPTY_RESPONSE:"     — 200 OK but JSON is missing required fields
 *
 * @param {string} dateString  — date in YYYY-MM-DD format
 * @returns {Promise<Object>}  — resolved APOD payload
 * @throws {Error}  Typed error consumed by callers
 */
async function fetchApodByDate(dateString) {
  const requestUrl = new URL(NASA_APOD_BASE);
  requestUrl.searchParams.set("api_key", NASA_API_KEY);
  requestUrl.searchParams.set("date",    dateString);
  requestUrl.searchParams.set("thumbs",  "true");

  let response;
  try {
    response = await fetch(requestUrl.toString());
  } catch (networkError) {
    throw new Error(
      "NETWORK_ERROR: Unable to reach NASA servers. " +
      "Please check your internet connection and try again."
    );
  }

  if (!response.ok) {
    const s = response.status;
    if (s === 400) throw new Error(
      "DATE_OUT_OF_RANGE: No APOD entry found for this date. " +
      `The archive begins on ${APOD_EPOCH_START} and ends at the most recently published entry.`
    );
    if (s === 403) throw new Error(
      "AUTH_ERROR: The NASA API key is invalid or has been revoked. " +
      "Verify your key at https://api.nasa.gov"
    );
    if (s === 429) throw new Error(
      "RATE_LIMIT: API rate limit reached. " +
      "NASA's free tier allows 1,000 requests per hour. Please wait and try again."
    );
    throw new Error(
      `SERVER_ERROR: NASA API returned HTTP ${s}. ` +
      "The service may be temporarily unavailable. Please try again shortly."
    );
  }

  const nasaData = await response.json();
  if (!nasaData || !nasaData.title) {
    throw new Error(
      "EMPTY_RESPONSE: The API returned an empty or unrecognized payload. " +
      "Please try a different date."
    );
  }
  return nasaData;
}

/**
 * Fetch a range of APOD entries between startDate and endDate (inclusive).
 * Returns an array of APOD objects sorted ascending by date.
 *
 * Used by loadLatestAvailableApod() to discover the most recently published
 * entry without guessing — NASA returns only dates that actually have data.
 *
 * Error taxonomy mirrors fetchApodByDate() for consistent error handling.
 *
 * @param {string} startDate — YYYY-MM-DD, on or after APOD_EPOCH_START
 * @param {string} endDate   — YYYY-MM-DD, today or earlier
 * @returns {Promise<Object[]>}  Array of APOD objects, sorted by date ascending
 * @throws {Error}  Typed error consumed by loadLatestAvailableApod()
 */
async function fetchApodRange(startDate, endDate) {
  const requestUrl = new URL(NASA_APOD_BASE);
  requestUrl.searchParams.set("api_key",    NASA_API_KEY);
  requestUrl.searchParams.set("start_date", startDate);
  requestUrl.searchParams.set("end_date",   endDate);
  requestUrl.searchParams.set("thumbs",     "true");

  let response;
  try {
    response = await fetch(requestUrl.toString());
  } catch (networkError) {
    throw new Error(
      "NETWORK_ERROR: Unable to reach NASA servers. " +
      "Please check your internet connection and try again."
    );
  }

  if (!response.ok) {
    const s = response.status;
    if (s === 400) throw new Error(
      "DATE_OUT_OF_RANGE: The requested date range is invalid. " +
      `Ensure start_date is on or after ${APOD_EPOCH_START} and end_date is not in the future.`
    );
    if (s === 403) throw new Error(
      "AUTH_ERROR: The NASA API key is invalid or has been revoked. " +
      "Verify your key at https://api.nasa.gov"
    );
    if (s === 429) throw new Error(
      "RATE_LIMIT: API rate limit reached. " +
      "NASA's free tier allows 1,000 requests per hour. Please wait and try again."
    );
    throw new Error(
      `SERVER_ERROR: NASA API returned HTTP ${s}. ` +
      "The service may be temporarily unavailable."
    );
  }

  const apodArray = await response.json();
  if (!Array.isArray(apodArray) || apodArray.length === 0) {
    throw new Error(
      "EMPTY_RESPONSE: No APOD entries were returned for the requested date range."
    );
  }

  // Sort ascending by date string — lexicographic order is correct for YYYY-MM-DD
  apodArray.sort((a, b) => a.date.localeCompare(b.date));
  return apodArray;
}

// ─────────────────────────────────────────────
// 6. TRANSMISSION OVERLAY
// ─────────────────────────────────────────────

/**
 * Show the full-screen transmission loading overlay.
 * Calling this while the overlay is already visible just updates the label.
 * @param {string} [labelText="TRANSMITTING"]
 */
function showTransmissionOverlay(labelText = "TRANSMITTING") {
  const overlayEl = document.getElementById("transmission-overlay");
  document.getElementById("tx-label").textContent = labelText;
  overlayEl.classList.add("is-visible");
  overlayEl.setAttribute("aria-hidden", "false");
}

/**
 * Hide the full-screen transmission overlay.
 * Always called from a finally{} block to guarantee dismissal on both
 * success and failure paths. Safe to call when already hidden.
 */
function hideTransmissionOverlay() {
  const overlayEl = document.getElementById("transmission-overlay");
  overlayEl.classList.remove("is-visible");
  overlayEl.setAttribute("aria-hidden", "true");
}

// ─────────────────────────────────────────────
// 7. HERO VIEWER — loadApodIntoHero()
// ─────────────────────────────────────────────

/**
 * Fetch an APOD entry and update every element of the hero section in-place.
 *
 * PREVIOUS DAY & NEXT DAY BUTTON WIRING (v3.3)
 * ─────────────────────────────────────────────
 * Both navigation buttons are re-wired on every successful load using
 * nasaData.date — the ACTUAL displayed date, not the originally requested
 * dateString. This distinction matters for two reasons:
 *
 *   1. The single-date fallback (v3.2) could have turned a "today" request
 *      into a "yesterday" result. The buttons must step relative to what is
 *      shown, not what was asked for.
 *
 *   2. The Next Day button must compare against latestPublishedDate (set by
 *      loadLatestAvailableApod). If latestPublishedDate is null (range query
 *      not yet resolved or failed), we fall back to etToday as the boundary.
 *
 * BUTTON STATES:
 *   hero-prev-btn  disabled  ↔  nasaData.date === APOD_EPOCH_START
 *   hero-next-btn  disabled  ↔  nasaData.date >= latestBoundary
 *
 * SOURCE LABEL LOGIC:
 *   forceSourceLabel set     → use that label (e.g. "◈ Latest Available")
 *   nasaData.date === etToday → "◈ Today's Picture"
 *   else                      → "◈ Archive Entry"
 *
 * OPTIONAL PARAMETER:
 *   { forceSourceLabel } — overrides the automatic label calculation.
 *   Used by loadLatestAvailableApod() to label a fallback-to-yesterday
 *   result as "◈ Latest Available" rather than "◈ Archive Entry".
 *
 * @param {string} dateString                     — YYYY-MM-DD date to load
 * @param {Object} [options]
 * @param {string|null} [options.forceSourceLabel] — override the source tag text
 */
async function loadApodIntoHero(dateString, { forceSourceLabel = null } = {}) {
  // Snapshot ET today once so comparisons are consistent throughout this call
  const etToday = getTodayDateString();

  // ── DOM references (must match IDs in index.html) ──────────────────────
  const heroBgEl       = document.getElementById("hero-bg");
  const heroDateEl     = document.getElementById("hero-date");
  const heroSourceTag  = document.getElementById("hero-source-tag");
  const heroTitleEl    = document.getElementById("hero-title-text");
  const heroExpEl      = document.getElementById("hero-explanation");
  const heroCopyEl     = document.getElementById("hero-copyright");
  const heroCreditEl   = document.getElementById("hero-credit-value");
  const heroVersionEl  = document.getElementById("hero-version-value");
  const heroDownloadEl = document.getElementById("hero-download-btn");
  const heroStripEl    = document.getElementById("hero-detail-strip");
  const heroPrevBtn    = document.getElementById("hero-prev-btn");
  const heroNextBtn    = document.getElementById("hero-next-btn");

  // Fade out the current hero image before loading the new one
  heroBgEl.style.opacity = "0";
  showTransmissionOverlay("ESTABLISHING LINK");

  try {
    // ── Fetch with intelligent single-date fallback ─────────────────────
    // If the caller is asking for today and the image is not yet published,
    // NASA returns 400. We silently retry yesterday in that case.
    // (When loadLatestAvailableApod() is in use this path is a last resort,
    //  because the range query already found the real latest date.)
    let nasaData;
    const isRequestForToday = (dateString === etToday);

    try {
      nasaData = await fetchApodByDate(dateString);
    } catch (primaryError) {
      if (isRequestForToday && primaryError.message.startsWith("DATE_OUT_OF_RANGE")) {
        const yesterdayString = getPreviousDayString(etToday);
        console.info(
          `[ARTMS] Today's APOD (${etToday}) is not yet published. ` +
          `Falling back to yesterday (${yesterdayString}).`
        );
        showTransmissionOverlay("LOCATING SIGNAL");
        nasaData = await fetchApodByDate(yesterdayString); // propagates to outer catch if it also fails
      } else {
        throw primaryError; // not a today/range error — surface immediately
      }
    }

    // ── Populate hero metadata ─────────────────────────────────────────

    heroDateEl.textContent = formatDateLabel(nasaData.date);

    // Source tag — use forced label if provided, otherwise derive it
    heroSourceTag.textContent = forceSourceLabel
      ? forceSourceLabel
      : (nasaData.date === etToday ? "◈ Today's Picture" : "◈ Archive Entry");

    heroTitleEl.textContent = nasaData.title;
    document.title          = `ARTMS — ${nasaData.title}`;
    heroExpEl.textContent   = nasaData.explanation;

    const creditText         = nasaData.copyright
      ? nasaData.copyright.replace(/\n/g, " ").trim()
      : "NASA / JPL";
    heroCopyEl.textContent   = `© ${creditText}`;
    heroCreditEl.textContent = creditText;

    heroVersionEl.textContent = nasaData.service_version ?? "—";

    // Ensure the detail strip is visible (may have been hidden by a prior error)
    heroStripEl.style.display = "";

    // Download HD — images only; fall back to standard url when hdurl absent
    if (nasaData.media_type === "image") {
      heroDownloadEl.href          = nasaData.hdurl || nasaData.url;
      heroDownloadEl.style.display = "inline-flex";
    } else {
      heroDownloadEl.style.display = "none";
    }

    // ── Wire navigation buttons using nasaData.date (actual displayed date) ──

    // PREVIOUS DAY
    const prevDate = getPreviousDayString(nasaData.date);
    const isAtEpoch = (nasaData.date <= APOD_EPOCH_START);
    heroPrevBtn.disabled = isAtEpoch;
    heroPrevBtn.onclick  = isAtEpoch ? null : () => loadApodIntoHero(prevDate);

    // NEXT DAY
    // latestBoundary: use the discovered latest date when available.
    // Falls back to etToday if loadLatestAvailableApod has not yet resolved
    // (e.g. if the range query failed and the single-date path ran instead).
    const latestBoundary = latestPublishedDate ?? etToday;
    const isAtLatest     = (nasaData.date >= latestBoundary);
    heroNextBtn.disabled = isAtLatest;

    if (!isAtLatest) {
      const nextDate      = getNextDayString(nasaData.date);
      heroNextBtn.onclick = () => loadApodIntoHero(nextDate);
    } else {
      heroNextBtn.onclick = null;
    }

    // ── Background image / video thumbnail ────────────────────────────────

    if (nasaData.media_type === "image") {
      const bgUrl           = nasaData.hdurl || nasaData.url;
      heroBgEl.classList.remove("loading");

      // Preload off-screen to prevent a visible blank flash on reveal
      const preloadImg      = new Image();
      preloadImg.onload     = () => {
        heroBgEl.style.backgroundImage = `url('${bgUrl}')`;
        heroBgEl.style.opacity         = "1";
        heroBgEl.setAttribute("aria-label", nasaData.title);
      };
      preloadImg.onerror    = () => { heroBgEl.classList.add("loading"); };
      preloadImg.src        = bgUrl;

    } else if (nasaData.media_type === "video") {
      heroBgEl.classList.remove("loading");
      if (nasaData.thumbnail_url) {
        heroBgEl.style.backgroundImage = `url('${nasaData.thumbnail_url}')`;
        heroBgEl.style.opacity         = "1";
      }
    }

    // Scroll to the hero so the user immediately sees the result
    document.getElementById("hero").scrollIntoView({ behavior: "smooth", block: "start" });

  } catch (heroError) {
    // ── Graceful degradation ─────────────────────────────────────────────
    console.warn("[ARTMS] Hero load failed:", heroError.message);

    heroDateEl.textContent  = dateString;
    heroTitleEl.textContent = "Signal Lost";
    heroExpEl.textContent   =
      "Could not retrieve the Astronomy Picture of the Day for this date. " +
      "NASA's servers may be temporarily unreachable, or the date may be " +
      "outside the published archive range. Please try a different date.";
    heroBgEl.classList.remove("loading");
    heroStripEl.style.display = "none";
    // Disable both nav buttons when there is no valid entry to navigate from
    heroPrevBtn.disabled = true;
    heroNextBtn.disabled = true;

    const msg = heroError.message;
    if      (msg.startsWith("NETWORK_ERROR"))    showError("Connection Failed",  msg.replace("NETWORK_ERROR: ",    ""));
    else if (msg.startsWith("AUTH_ERROR"))        showError("Auth Error",         msg.replace("AUTH_ERROR: ",       ""));
    else if (msg.startsWith("DATE_OUT_OF_RANGE")) showError("Date Out of Range",  msg.replace("DATE_OUT_OF_RANGE: ",""));
    else if (msg.startsWith("RATE_LIMIT"))        showError("Rate Limit Reached", msg.replace("RATE_LIMIT: ",       ""));
    else if (msg.startsWith("EMPTY_RESPONSE"))    showError("No Data Found",      msg.replace("EMPTY_RESPONSE: ",   ""));
    else                                          showError("Unexpected Error",   msg.replace(/^\w+: /, ""));

  } finally {
    hideTransmissionOverlay();
  }
}

// ─────────────────────────────────────────────
// 8. LATEST INIT — loadLatestAvailableApod()
// ─────────────────────────────────────────────

/**
 * Discover and display the most recently published APOD entry.
 *
 * STRATEGY
 * ─────────
 * Instead of guessing "today" and falling back once, this function queries
 * the APOD API for a LATEST_LOOKBACK_DAYS-day range ending at ET today.
 * NASA's API returns only dates that have actual published entries, so the
 * last element of the sorted response is definitively the most recent one.
 *
 * This approach is robust against:
 *   - Timezone gaps (no more "today doesn't exist yet" 400 errors on init)
 *   - Weekend/holiday gaps where NASA doesn't publish for multiple days
 *   - Any publish delays wider than a single day
 *
 * SIDE EFFECTS
 * ─────────────
 *   • Sets latestPublishedDate — used by the Next Day button boundary check
 *   • Updates date-picker.max  — prevents UI from showing unpublished dates
 *   • Calls loadApodIntoHero() with the discovered date and a label
 *
 * FALLBACK
 * ─────────
 * If the range query itself fails (network outage, auth error, etc.),
 * the function falls back to loadApodIntoHero(etToday) which has its own
 * single-date yesterday-fallback. latestPublishedDate remains null in this
 * case and hero-next-btn will use etToday as the boundary.
 */
async function loadLatestAvailableApod() {
  const etToday = getTodayDateString();

  // Compute the start of the look-back window.
  // We subtract (LATEST_LOOKBACK_DAYS - 1) days so the window is
  // LATEST_LOOKBACK_DAYS days wide inclusive of today.
  // Example: if today is 2025-04-09 and LATEST_LOOKBACK_DAYS = 7,
  //          startDate = 2025-04-03  →  window: Apr 03 – Apr 09 (7 days).
  const [ty, tm, td] = etToday.split("-").map(Number);
  const windowStartObj = new Date(ty, tm - 1, td - (LATEST_LOOKBACK_DAYS - 1));
  const startDate = [
    windowStartObj.getFullYear(),
    String(windowStartObj.getMonth() + 1).padStart(2, "0"),
    String(windowStartObj.getDate()).padStart(2, "0"),
  ].join("-");

  // Show the overlay during the range fetch phase
  showTransmissionOverlay("LOCATING LATEST SIGNAL");

  try {
    // ── Range query ────────────────────────────────────────────────────────
    // Returns an array already sorted ascending by fetchApodRange().
    const apodArray   = await fetchApodRange(startDate, etToday);
    const latestEntry = apodArray[apodArray.length - 1]; // last = most recent

    // Store globally — hero-next-btn reads this every time it is wired
    latestPublishedDate = latestEntry.date;

    // Sync date-picker.max to the true latest date.
    // This prevents the browser UI from offering dates NASA has not published.
    const datePickerEl = document.getElementById("date-picker");
    datePickerEl.max   = latestEntry.date;

    // Label logic:
    //   If the latest entry IS today  →  "◈ Today's Picture"
    //   If it is yesterday (or older) →  "◈ Latest Available"
    const sourceLabel = (latestEntry.date === etToday)
      ? "◈ Today's Picture"
      : "◈ Latest Available";

    console.info(
      `[ARTMS] Latest published APOD: ${latestEntry.date}` +
      (latestEntry.date !== etToday
        ? ` (ET today is ${etToday} — image not yet published)`
        : "")
    );

    // Load the confirmed latest entry — no fallback guesswork needed here
    await loadApodIntoHero(latestEntry.date, { forceSourceLabel: sourceLabel });

  } catch (rangeError) {
    // ── Fallback: range query failed — use single-date path ───────────────
    // loadApodIntoHero(etToday) still has its own yesterday-fallback, so
    // we remain resilient even without the range strategy.
    console.warn(
      "[ARTMS] Range query failed during init — falling back to single-date load:",
      rangeError.message
    );
    await loadApodIntoHero(etToday);

  } finally {
    // Always dismiss the overlay — loadApodIntoHero() also hides it in its
    // own finally, so this call is a safe no-op in the success path.
    hideTransmissionOverlay();
  }
}

// ─────────────────────────────────────────────
// 9. ARCHIVE CARDS
// ─────────────────────────────────────────────

/**
 * Fetch ARCHIVE_CARD_COUNT random APOD entries in parallel and populate
 * the archive grid with full-detail, clickable glassmorphism cards.
 *
 * Promise.allSettled() ensures one failed fetch does not block the others.
 * Failed entries are logged and silently skipped; an error banner appears
 * only when every single fetch fails.
 */
async function loadArchiveCards() {
  const archiveGridEl = document.getElementById("archive-grid");

  // Clear existing content and show skeleton placeholders
  archiveGridEl.innerHTML = "";
  for (let i = 0; i < ARCHIVE_CARD_COUNT; i++) {
    const skeleton     = document.createElement("div");
    skeleton.className = "skeleton-card";
    archiveGridEl.appendChild(skeleton);
  }

  const randomDates   = getRandomDateStrings();
  const fetchPromises = randomDates.map((date) => fetchApodByDate(date));
  const results       = await Promise.allSettled(fetchPromises);

  archiveGridEl.innerHTML = "";
  let renderedCount = 0;

  results.forEach((result) => {
    if (result.status === "fulfilled") {
      renderArchiveCard(result.value);
      renderedCount++;
    } else {
      console.warn("[ARTMS] Archive card skipped:", result.reason?.message);
    }
  });

  if (renderedCount === 0) {
    showError(
      "Archive Unavailable",
      "Could not load any archive entries. Please check your connection and try shuffling again."
    );
  }
}

/**
 * Build one full-detail archive card and append it to the archive grid.
 *
 * Contents:
 *   • Thumbnail or video placeholder
 *   • Gold date chip
 *   • Full title
 *   • Complete explanation in a scrollable pocket (no line clamping)
 *   • Metadata row: credit + service version
 *   • "▶ View Full Entry" CTA — calls loadApodIntoHero(date)
 *   • "⬇ HD" download link (image entries only)
 *
 * The card itself is keyboard-accessible (tabIndex=0, Enter/Space handling).
 * Action buttons use stopPropagation() to prevent double-firing with the
 * card's own click handler.
 *
 * @param {Object} nasaData — Resolved APOD API response
 */
function renderArchiveCard(nasaData) {
  const archiveGridEl = document.getElementById("archive-grid");

  const card = document.createElement("article");
  card.className = "archive-card";
  card.tabIndex  = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `View full entry: ${nasaData.title}, ${nasaData.date}`);

  // ── Thumbnail ──────────────────────────────────────────────────────────
  const imageWrapper     = document.createElement("div");
  imageWrapper.className = "card-image-wrapper";

  if (nasaData.media_type === "image") {
    const imgEl   = document.createElement("img");
    imgEl.src     = nasaData.url;
    imgEl.alt     = nasaData.title;
    imgEl.loading = "lazy";
    imgEl.onerror = () => {
      imgEl.style.display = "none";
      imageWrapper.style.background =
        "linear-gradient(135deg, var(--clr-deep), var(--clr-nasa))";
    };
    imageWrapper.appendChild(imgEl);
  } else {
    const placeholder     = document.createElement("div");
    placeholder.className = "card-video-placeholder";
    placeholder.innerHTML =
      `<span class="play-icon">▶</span><span class="video-label">Video Entry</span>`;
    if (nasaData.thumbnail_url) {
      imageWrapper.style.backgroundImage    = `url('${nasaData.thumbnail_url}')`;
      imageWrapper.style.backgroundSize     = "cover";
      imageWrapper.style.backgroundPosition = "center";
    }
    imageWrapper.appendChild(placeholder);
  }

  const dateBadge       = document.createElement("span");
  dateBadge.className   = "card-date-chip";
  dateBadge.textContent = nasaData.date;
  imageWrapper.appendChild(dateBadge);

  // ── Body ───────────────────────────────────────────────────────────────
  const cardBody = document.createElement("div");
  cardBody.className = "card-body";

  const cardTitle       = document.createElement("h3");
  cardTitle.className   = "card-title";
  cardTitle.textContent = nasaData.title;

  const divider     = document.createElement("div");
  divider.className = "card-divider";

  const explanationEl       = document.createElement("p");
  explanationEl.className   = "card-explanation";
  explanationEl.textContent = nasaData.explanation;

  cardBody.appendChild(cardTitle);
  cardBody.appendChild(divider);
  cardBody.appendChild(explanationEl);

  // ── Metadata ───────────────────────────────────────────────────────────
  const cardMetaRow     = document.createElement("div");
  cardMetaRow.className = "card-meta-row";

  const creditItem = document.createElement("div");
  creditItem.className = "card-meta-item";
  creditItem.innerHTML = `
    <span class="card-meta-item__label">Credit</span>
    <span class="card-meta-item__value">${
      nasaData.copyright ? nasaData.copyright.replace(/\n/g, " ").trim() : "NASA / JPL"
    }</span>`;

  const versionItem = document.createElement("div");
  versionItem.className = "card-meta-item";
  versionItem.innerHTML = `
    <span class="card-meta-item__label">Service Version</span>
    <span class="card-meta-item__value">${nasaData.service_version ?? "—"}</span>`;

  cardMetaRow.appendChild(creditItem);
  cardMetaRow.appendChild(versionItem);

  // ── Actions ────────────────────────────────────────────────────────────
  const cardActions     = document.createElement("div");
  cardActions.className = "card-actions";

  const viewBtn     = document.createElement("button");
  viewBtn.className = "btn-view-in-hero";
  viewBtn.textContent = "▶  View Full Entry";
  viewBtn.setAttribute("aria-label", `Load ${nasaData.title} into the hero viewer`);
  viewBtn.addEventListener("click", (e) => { e.stopPropagation(); loadApodIntoHero(nasaData.date); });
  cardActions.appendChild(viewBtn);

  if (nasaData.media_type === "image" && (nasaData.hdurl || nasaData.url)) {
    const downloadLink       = document.createElement("a");
    downloadLink.className   = "btn-download";
    downloadLink.href        = nasaData.hdurl || nasaData.url;
    downloadLink.target      = "_blank";
    downloadLink.rel         = "noopener";
    downloadLink.textContent = "⬇ HD";
    downloadLink.setAttribute("aria-label", `Download HD image: ${nasaData.title}`);
    downloadLink.addEventListener("click", (e) => e.stopPropagation());
    cardActions.appendChild(downloadLink);
  }

  // ── Assemble ───────────────────────────────────────────────────────────
  card.appendChild(imageWrapper);
  card.appendChild(cardBody);
  card.appendChild(cardMetaRow);
  card.appendChild(cardActions);

  card.addEventListener("click", () => loadApodIntoHero(nasaData.date));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      loadApodIntoHero(nasaData.date);
    }
  });

  archiveGridEl.appendChild(card);
}

// ─────────────────────────────────────────────
// 10. SEARCH HANDLER
// ─────────────────────────────────────────────

/**
 * Handle the "JUMP TO DATE" button click.
 *
 * All three date boundaries use getTodayDateString() (ET-synchronised):
 *   Upper: selectedDate must not exceed ET today
 *   Lower: selectedDate must not precede APOD_EPOCH_START
 *
 * On valid input, calls loadApodIntoHero() which updates the hero in-place.
 */
async function handleDatePickerSearch() {
  const datePickerEl = document.getElementById("date-picker");
  const selectedDate = datePickerEl.value;

  if (!selectedDate) {
    showError("No Date Selected", "Please pick a date using the calendar before jumping.");
    return;
  }

  // Use ET today as the upper bound — guards against local "tomorrow" picks
  const etToday = getTodayDateString();
  // Also respect the more precise latestPublishedDate if available
  const upperBound = latestPublishedDate ?? etToday;

  if (selectedDate > upperBound) {
    showError(
      "Future Date Selected",
      "The APOD archive only contains entries up to the most recently published date. " +
      "Please choose a past date."
    );
    return;
  }

  if (selectedDate < APOD_EPOCH_START) {
    showError(
      "Date Too Early",
      `The APOD archive begins on ${APOD_EPOCH_START}. Please select a more recent date.`
    );
    return;
  }

  clearError();
  setSearchLoading(true);
  try {
    await loadApodIntoHero(selectedDate);
  } finally {
    setSearchLoading(false);
  }
}

// ─────────────────────────────────────────────
// 11. UI HELPERS
// ─────────────────────────────────────────────

/**
 * Toggle the search button and date picker between idle and loading states.
 * @param {boolean} isLoading
 */
function setSearchLoading(isLoading) {
  const searchBtnEl  = document.getElementById("search-btn");
  const btnLabelEl   = document.getElementById("btn-label");
  const datePickerEl = document.getElementById("date-picker");

  if (isLoading) {
    btnLabelEl.innerHTML  = `<span class="spin"></span> LOADING`;
    searchBtnEl.disabled  = true;
    datePickerEl.disabled = true;
  } else {
    btnLabelEl.innerHTML  = "JUMP TO DATE";
    searchBtnEl.disabled  = false;
    datePickerEl.disabled = false;
  }
}

/**
 * Show the error banner with a category title and detail body.
 * Scrolls the banner into view automatically.
 * @param {string} title
 * @param {string} body
 */
function showError(title, body) {
  const bannerEl = document.getElementById("error-banner");
  document.getElementById("error-title").textContent = `⚠ ${title}`;
  document.getElementById("error-body").textContent  = body;
  bannerEl.classList.add("visible");
  bannerEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Hide the error banner */
function clearError() {
  document.getElementById("error-banner").classList.remove("visible");
}

// ─────────────────────────────────────────────
// 12. EVENT LISTENERS & INIT
// ─────────────────────────────────────────────

// "JUMP TO DATE" button
document.getElementById("search-btn").addEventListener("click", handleDatePickerSearch);

// Enter key while the date picker is focused
document.getElementById("date-picker").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleDatePickerSearch();
});

// Error banner close button
document.getElementById("error-close").addEventListener("click", clearError);

// "Shuffle Archive" nav link
document.getElementById("nav-shuffle-btn").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("archive-section").scrollIntoView({ behavior: "smooth" });
  loadArchiveCards();
});

// Inline "Shuffle" button below the grid
document.getElementById("shuffle-btn").addEventListener("click", loadArchiveCards);

// Initialise date picker bounds.
// max is set to ET today initially; loadLatestAvailableApod() will tighten it
// to latestPublishedDate once the range query resolves.
const datePickerEl = document.getElementById("date-picker");
datePickerEl.max   = getTodayDateString();
datePickerEl.min   = APOD_EPOCH_START;

// ─────────────────────────────────────────────
// PAGE INITIALISATION
//
// Two independent async operations start in parallel on page load:
//
//   1. loadLatestAvailableApod()  — discovers the true latest published
//      date via a 7-day range query, updates date-picker.max, sets
//      latestPublishedDate, then loads that entry into the hero.
//      Falls back to loadApodIntoHero(etToday) on range-query failure.
//
//   2. loadArchiveCards()  — fetches 4 random past APOD entries via
//      Promise.allSettled() and renders them as glassmorphism cards.
//
// Neither operation blocks the other.
// ─────────────────────────────────────────────
loadLatestAvailableApod();
loadArchiveCards();
