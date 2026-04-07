/**
 * ARTMS — main.js  v3.1
 * Astronomical Real-Time Media System
 *
 * Architecture:
 *   - The HERO is the full APOD "viewer". It shows whatever entry is active
 *     (today's on load, or any archived entry when a card is clicked).
 *   - The ARCHIVE SECTION shows 4 random APOD cards on page load.
 *     Clicking any card calls loadApodIntoHero(date) — no page reload.
 *   - The date picker also calls loadApodIntoHero(date) directly.
 *   - All navigation is in-app. Zero external redirects.
 *
 * Sections:
 *   1. Configuration & Constants
 *   2. Star Field Canvas Animation
 *   3. Utility Functions
 *   4. API Layer               — fetchApodByDate()
 *   5. Transmission Overlay    — showTransmissionOverlay(), hideTransmissionOverlay()
 *   6. Hero Viewer             — loadApodIntoHero(dateString)
 *   7. Archive Cards           — loadArchiveCards(), renderArchiveCard()
 *   8. Search Handler          — handleDatePickerSearch()
 *   9. UI Helpers              — showError(), clearError(), setSearchLoading(), etc.
 *  10. Event Listeners & Init
 */

// ─────────────────────────────────────────────
// 1. CONFIGURATION & CONSTANTS
// ─────────────────────────────────────────────

/**
 * NASA API key — read from the Vite .env file at build time.
 * The VITE_ prefix is required for Vite to expose it to the browser bundle.
 * Store your key only in .env, never directly in source code.
 *
 * @see https://vitejs.dev/guide/env-and-mode
 */
const NASA_API_KEY = import.meta.env.VITE_NASA_API_KEY;

/** NASA Astronomy Picture of the Day API endpoint */
const NASA_APOD_BASE = "https://api.nasa.gov/planetary/apod";

/** Earliest date in the APOD archive */
const APOD_EPOCH_START = "1995-06-16";

/**
 * How many random archive cards to load on page initialisation.
 * Changing this number also updates the grid automatically.
 */
const ARCHIVE_CARD_COUNT = 4;

// ─────────────────────────────────────────────
// 2. STAR FIELD CANVAS ANIMATION
// ─────────────────────────────────────────────

/**
 * Initialise and animate the fixed star field canvas that sits behind the page.
 * Stars twinkle via a per-star sine-wave opacity oscillation each frame.
 * Wrapped in an IIFE to keep internal state out of the module scope.
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

  /** Create one star with randomised position, size, and twinkle phase */
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

  /**
   * Draw one animation frame — clears canvas, then paints each star
   * with a sine-modulated opacity to create a gentle twinkle effect.
   * @param {DOMHighResTimeStamp} timestamp
   */
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
// 3. UTILITY FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Return today's date as a YYYY-MM-DD string in local time.
 * This is the exact format accepted by the APOD API's `date` parameter.
 * @returns {string}  e.g. "2025-07-20"
 */
function getTodayDateString() {
  const now  = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const dd   = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a YYYY-MM-DD string into a long human-readable date label.
 * e.g. "2024-07-20" → "July 20, 2024"
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
 * Subtract one calendar day from a YYYY-MM-DD date string.
 * Used by the "← Previous Day" button on the hero detail strip.
 * @param {string} isoDate
 * @returns {string}
 */
function getPreviousDayString(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const prev = new Date(year, month - 1, day - 1);
  const yyyy = prev.getFullYear();
  const mm   = String(prev.getMonth() + 1).padStart(2, "0");
  const dd   = String(prev.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Generate ARCHIVE_CARD_COUNT unique random date strings, each between
 * APOD_EPOCH_START and today. Used to populate the archive shelf on load.
 * @returns {string[]}  Array of unique YYYY-MM-DD date strings
 */
function getRandomDateStrings() {
  const epochMs = new Date(APOD_EPOCH_START).getTime();
  const todayMs = new Date(getTodayDateString()).getTime();
  const dates   = new Set();

  // Keep generating until we have the required number of unique dates
  while (dates.size < ARCHIVE_CARD_COUNT) {
    const randomMs   = epochMs + Math.random() * (todayMs - epochMs);
    const randomDate = new Date(randomMs);
    const yyyy = randomDate.getFullYear();
    const mm   = String(randomDate.getMonth() + 1).padStart(2, "0");
    const dd   = String(randomDate.getDate()).padStart(2, "0");
    dates.add(`${yyyy}-${mm}-${dd}`);
  }

  return Array.from(dates);
}

// ─────────────────────────────────────────────
// 4. API LAYER
// ─────────────────────────────────────────────

/**
 * Fetch the APOD entry for a specific date from NASA's Open API.
 *
 * Error handling strategy:
 *   • Network failures  → fetch() throws TypeError → caught, re-thrown with "NETWORK_ERROR:" prefix
 *   • HTTP 400          → date out of archive range → "DATE_OUT_OF_RANGE:"
 *   • HTTP 403          → invalid API key          → "AUTH_ERROR:"
 *   • HTTP 429          → rate limit exceeded       → "RATE_LIMIT:"
 *   • Other HTTP errors → server-side issue         → "SERVER_ERROR:"
 *   • Malformed JSON    → missing required fields   → "EMPTY_RESPONSE:"
 *
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} Resolved APOD data:
 *   title, explanation, url, hdurl (optional), media_type,
 *   copyright (optional), service_version, date, thumbnail_url (optional)
 * @throws {Error} Typed error — prefix consumed by the UI layer
 */
async function fetchApodByDate(dateString) {
  // Build the full request URL with all required query parameters
  const requestUrl = new URL(NASA_APOD_BASE);
  requestUrl.searchParams.set("api_key", NASA_API_KEY);
  requestUrl.searchParams.set("date",    dateString);
  requestUrl.searchParams.set("thumbs",  "true"); // enables thumbnail_url for video entries

  let response;

  try {
    // fetch() only throws on network-level failure — not on non-2xx HTTP status
    response = await fetch(requestUrl.toString());
  } catch (networkError) {
    throw new Error(
      "NETWORK_ERROR: Unable to reach NASA servers. " +
      "Please check your internet connection and try again."
    );
  }

  if (!response.ok) {
    const httpStatus = response.status;

    if (httpStatus === 400) {
      throw new Error(
        "DATE_OUT_OF_RANGE: No APOD entry found for this date. " +
        `The archive begins on ${APOD_EPOCH_START} and ends today.`
      );
    }
    if (httpStatus === 403) {
      throw new Error(
        "AUTH_ERROR: The NASA API key is invalid or has been revoked. " +
        "Verify your key at https://api.nasa.gov"
      );
    }
    if (httpStatus === 429) {
      throw new Error(
        "RATE_LIMIT: API rate limit reached. " +
        "NASA's free tier allows 1,000 requests per hour. Please wait and try again."
      );
    }
    throw new Error(
      `SERVER_ERROR: NASA API returned HTTP ${httpStatus}. ` +
      "The service may be temporarily unavailable."
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

// ─────────────────────────────────────────────
// 5. TRANSMISSION OVERLAY
// ─────────────────────────────────────────────

/**
 * Show the full-screen transmission loading overlay.
 * @param {string} [labelText="TRANSMITTING"] — text shown under the rings
 */
function showTransmissionOverlay(labelText = "TRANSMITTING") {
  const overlayEl = document.getElementById("transmission-overlay");
  document.getElementById("tx-label").textContent = labelText;
  overlayEl.classList.add("is-visible");
  overlayEl.setAttribute("aria-hidden", "false");
}

/**
 * Hide the full-screen transmission overlay.
 * Always called in the finally{} block of every async fetch.
 */
function hideTransmissionOverlay() {
  const overlayEl = document.getElementById("transmission-overlay");
  overlayEl.classList.remove("is-visible");
  overlayEl.setAttribute("aria-hidden", "true");
}

// ─────────────────────────────────────────────
// 6. HERO VIEWER — loadApodIntoHero()
// ─────────────────────────────────────────────

/**
 * The central function of ARTMS v3.1.
 *
 * Fetches the APOD for the given date and updates the hero section in-place:
 *   • Full-screen background image (preloaded to avoid flash)
 *   • Full title and COMPLETE description (no clamping in the hero)
 *   • Credit / copyright
 *   • Service version
 *   • Download HD link (hidden for video entries)
 *   • "← Previous Day" button wired to the new active date
 *   • Source tag updated ("Today's Picture" vs "Archive Entry")
 *
 * This function is called by:
 *   • Page init                    → loadApodIntoHero(today)
 *   • Archive card click           → loadApodIntoHero(card.date)
 *   • Date picker search           → loadApodIntoHero(selectedDate)
 *   • Previous Day button          → loadApodIntoHero(previousDate)
 *
 * After loading, the page scrolls to the top of the hero so the user
 * immediately sees the full image and description.
 *
 * @param {string} dateString - YYYY-MM-DD date to load into the hero
 */
async function loadApodIntoHero(dateString) {
  // ── Cache all hero DOM references (must match index.html IDs) ──────────
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

  // Fade out the current hero image before loading the new one
  heroBgEl.style.opacity = "0";

  showTransmissionOverlay("ESTABLISHING LINK");

  try {
    const nasaData = await fetchApodByDate(dateString);

    // ── Date and source tag ──────────────────────────────────────────────
    heroDateEl.textContent = formatDateLabel(nasaData.date);
    heroSourceTag.textContent = (nasaData.date === getTodayDateString())
      ? "◈ Today's Picture"
      : "◈ Archive Entry";

    // ── Title ────────────────────────────────────────────────────────────
    heroTitleEl.textContent = nasaData.title;
    document.title = `ARTMS — ${nasaData.title}`;

    // ── Full description — no clamping in the hero ────────────────────────
    heroExpEl.textContent = nasaData.explanation;

    // ── Credit / copyright ───────────────────────────────────────────────
    const creditText = nasaData.copyright
      ? nasaData.copyright.replace(/\n/g, " ").trim()
      : "NASA / JPL";
    heroCopyEl.textContent   = `© ${creditText}`;
    heroCreditEl.textContent = creditText;

    // ── Service version ──────────────────────────────────────────────────
    heroVersionEl.textContent = nasaData.service_version ?? "—";

    // ── Download HD button ───────────────────────────────────────────────
    // Show for image entries only; link to hdurl or fall back to url
    if (nasaData.media_type === "image") {
      heroDownloadEl.href          = nasaData.hdurl || nasaData.url;
      heroDownloadEl.style.display = "inline-flex";
    } else {
      heroDownloadEl.style.display = "none";
    }

    // ── Wire the "← Previous Day" button to this entry's date ────────────
    // Re-assign the onclick each time so it always refers to the active date
    heroPrevBtn.onclick = () => {
      const previousDate = getPreviousDayString(nasaData.date);
      if (previousDate < APOD_EPOCH_START) {
        showError(
          "Archive Boundary Reached",
          `The APOD archive begins on ${APOD_EPOCH_START}. There are no earlier entries.`
        );
        return;
      }
      loadApodIntoHero(previousDate);
    };

    // ── Background image ─────────────────────────────────────────────────
    if (nasaData.media_type === "image") {
      const bgUrl = nasaData.hdurl || nasaData.url;
      heroBgEl.classList.remove("loading");

      // Preload off-screen to avoid a blank flash on reveal
      const preloadImg  = new Image();
      preloadImg.onload = () => {
        heroBgEl.style.backgroundImage = `url('${bgUrl}')`;
        heroBgEl.style.opacity = "1";
        heroBgEl.setAttribute("aria-label", nasaData.title);
      };
      preloadImg.onerror = () => {
        heroBgEl.classList.add("loading");
      };
      preloadImg.src = bgUrl;

    } else if (nasaData.media_type === "video") {
      heroBgEl.classList.remove("loading");
      if (nasaData.thumbnail_url) {
        heroBgEl.style.backgroundImage = `url('${nasaData.thumbnail_url}')`;
        heroBgEl.style.opacity = "1";
      }
    }

    // ── Scroll to the hero so the user sees the result ────────────────────
    document.getElementById("hero").scrollIntoView({ behavior: "smooth", block: "start" });

  } catch (heroError) {
    // Non-fatal: show graceful fallback text; log the error for debugging
    console.warn("[ARTMS] Hero load failed:", heroError.message);

    heroDateEl.textContent   = dateString;
    heroTitleEl.textContent  = "Signal Lost";
    heroExpEl.textContent    =
      "Could not retrieve the Astronomy Picture of the Day for this date. " +
      "NASA's servers may be temporarily unreachable, or the date may be outside " +
      "the archive range. Please try a different date.";
    heroBgEl.classList.remove("loading");
    heroStripEl.style.display = "none";

    // Also surface the error in the archive banner so it's hard to miss
    const msg = heroError.message;
    if      (msg.startsWith("NETWORK_ERROR"))       showError("Connection Failed",    msg.replace("NETWORK_ERROR: ",      ""));
    else if (msg.startsWith("AUTH_ERROR"))           showError("Auth Error",           msg.replace("AUTH_ERROR: ",         ""));
    else if (msg.startsWith("DATE_OUT_OF_RANGE"))    showError("Date Out of Range",    msg.replace("DATE_OUT_OF_RANGE: ", ""));
    else if (msg.startsWith("RATE_LIMIT"))           showError("Rate Limit Reached",   msg.replace("RATE_LIMIT: ",         ""));
    else if (msg.startsWith("EMPTY_RESPONSE"))       showError("No Data Found",        msg.replace("EMPTY_RESPONSE: ",     ""));
    else                                             showError("Unexpected Error",      msg.replace(/^\w+: /, ""));

  } finally {
    hideTransmissionOverlay();
  }
}

// ─────────────────────────────────────────────
// 7. ARCHIVE CARDS
// ─────────────────────────────────────────────

/**
 * Load ARCHIVE_CARD_COUNT random APOD entries in parallel and populate
 * the archive grid with full-detail, clickable cards.
 *
 * Uses Promise.allSettled so that a single failed fetch does not
 * prevent the other cards from rendering. Failed entries are simply
 * skipped without surfacing an error banner.
 *
 * Called on page init and whenever the user clicks "Shuffle Archive".
 */
async function loadArchiveCards() {
  const archiveGridEl = document.getElementById("archive-grid");

  // Clear the grid and show skeleton placeholders while fetching
  archiveGridEl.innerHTML = "";
  for (let i = 0; i < ARCHIVE_CARD_COUNT; i++) {
    const skeleton     = document.createElement("div");
    skeleton.className = "skeleton-card";
    archiveGridEl.appendChild(skeleton);
  }

  // Generate random dates and fetch them all in parallel
  const randomDates   = getRandomDateStrings();
  const fetchPromises = randomDates.map((date) => fetchApodByDate(date));
  const results       = await Promise.allSettled(fetchPromises);

  // Clear skeletons — replace with real cards (skip any failed fetches)
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

  // If every fetch failed, show a gentle error instead of an empty grid
  if (renderedCount === 0) {
    showError(
      "Archive Unavailable",
      "Could not load any archive entries. Please check your connection and try shuffling again."
    );
  }
}

/**
 * Build and append one archive card to the archive grid.
 *
 * Each card includes:
 *   • Thumbnail image (or video placeholder)
 *   • Gold date chip
 *   • Full title
 *   • Complete explanation in a scrollable pocket (no truncation)
 *   • Metadata row: credit + service version
 *   • "▶ View Full Entry" button — calls loadApodIntoHero(date), scrolls to hero
 *   • "⬇ Download HD" button (hidden for video entries)
 *
 * The entire card element is also keyboard-accessible and fires
 * loadApodIntoHero() on Enter/Space so screen reader users can navigate it.
 *
 * @param {Object} nasaData - Resolved APOD API response object
 */
function renderArchiveCard(nasaData) {
  const archiveGridEl = document.getElementById("archive-grid");

  // ── Card shell ─────────────────────────────────────────────────────────
  const card = document.createElement("article");
  card.className    = "archive-card";
  card.tabIndex     = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `View full entry: ${nasaData.title}, ${nasaData.date}`);

  // ── Image / Video thumbnail ────────────────────────────────────────────
  const imageWrapper     = document.createElement("div");
  imageWrapper.className = "card-image-wrapper";

  if (nasaData.media_type === "image") {
    const imgEl    = document.createElement("img");
    imgEl.src      = nasaData.url;
    imgEl.alt      = nasaData.title;
    imgEl.loading  = "lazy";
    imgEl.onerror  = () => {
      imgEl.style.display = "none";
      imageWrapper.style.background =
        "linear-gradient(135deg, var(--clr-deep), var(--clr-nasa))";
    };
    imageWrapper.appendChild(imgEl);
  } else {
    // Video entry placeholder
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

  // Gold date chip in the bottom-left of the image
  const dateBadge       = document.createElement("span");
  dateBadge.className   = "card-date-chip";
  dateBadge.textContent = nasaData.date;
  imageWrapper.appendChild(dateBadge);

  // ── Card body: title + explanation ─────────────────────────────────────
  const cardBody = document.createElement("div");
  cardBody.className = "card-body";

  const cardTitle       = document.createElement("h3");
  cardTitle.className   = "card-title";
  cardTitle.textContent = nasaData.title;

  const divider     = document.createElement("div");
  divider.className = "card-divider";

  // Full explanation — scrollable pocket, no line-clamping
  const explanationEl       = document.createElement("p");
  explanationEl.className   = "card-explanation";
  explanationEl.textContent = nasaData.explanation;

  cardBody.appendChild(cardTitle);
  cardBody.appendChild(divider);
  cardBody.appendChild(explanationEl);

  // ── Metadata row: credit + service version ─────────────────────────────
  const cardMetaRow     = document.createElement("div");
  cardMetaRow.className = "card-meta-row";

  // Credit
  const creditItem                              = document.createElement("div");
  creditItem.className                          = "card-meta-item";
  creditItem.innerHTML                          = `
    <span class="card-meta-item__label">Credit</span>
    <span class="card-meta-item__value">${
      nasaData.copyright
        ? nasaData.copyright.replace(/\n/g, " ").trim()
        : "NASA / JPL"
    }</span>
  `;

  // Service version
  const versionItem                             = document.createElement("div");
  versionItem.className                         = "card-meta-item";
  versionItem.innerHTML                         = `
    <span class="card-meta-item__label">Service Version</span>
    <span class="card-meta-item__value">${nasaData.service_version ?? "—"}</span>
  `;

  cardMetaRow.appendChild(creditItem);
  cardMetaRow.appendChild(versionItem);

  // ── Action footer ──────────────────────────────────────────────────────
  const cardActions     = document.createElement("div");
  cardActions.className = "card-actions";

  // "▶ View Full Entry" — the primary CTA.
  // Loads this date's APOD into the hero and scrolls to the top of the page.
  // Uses stopPropagation so clicking this button doesn't also fire the card's
  // own click handler (which does the same thing, but both firing would be redundant).
  const viewBtn         = document.createElement("button");
  viewBtn.className     = "btn-view-in-hero";
  viewBtn.textContent   = "▶  View Full Entry";
  viewBtn.setAttribute("aria-label", `Load ${nasaData.title} into the hero viewer`);
  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    loadApodIntoHero(nasaData.date);
  });
  cardActions.appendChild(viewBtn);

  // "⬇ Download HD" — only available for image entries
  if (nasaData.media_type === "image" && (nasaData.hdurl || nasaData.url)) {
    const downloadLink         = document.createElement("a");
    downloadLink.className     = "btn-download";
    downloadLink.href          = nasaData.hdurl || nasaData.url;
    downloadLink.target        = "_blank";
    downloadLink.rel           = "noopener";
    downloadLink.textContent   = "⬇ HD";
    downloadLink.setAttribute("aria-label", `Download HD image: ${nasaData.title}`);
    // Prevent the card's click handler from firing when the link is clicked
    downloadLink.addEventListener("click", (e) => e.stopPropagation());
    cardActions.appendChild(downloadLink);
  }

  // ── Assemble the card ──────────────────────────────────────────────────
  card.appendChild(imageWrapper);
  card.appendChild(cardBody);
  card.appendChild(cardMetaRow);
  card.appendChild(cardActions);

  // ── Whole-card click handler ───────────────────────────────────────────
  // Clicking anywhere on the card (except the action buttons) loads the
  // entry into the hero viewer — no page reload, no external navigation.
  card.addEventListener("click", () => loadApodIntoHero(nasaData.date));

  // Keyboard accessibility: Enter or Space activates the card
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      loadApodIntoHero(nasaData.date);
    }
  });

  archiveGridEl.appendChild(card);
}

// ─────────────────────────────────────────────
// 8. DATE PICKER SEARCH
// ─────────────────────────────────────────────

/**
 * Handle the "JUMP TO DATE" button click.
 * Validates the selected date, then calls loadApodIntoHero() directly —
 * no separate result card is created; the hero viewer updates instead.
 */
async function handleDatePickerSearch() {
  const datePickerEl = document.getElementById("date-picker");
  const selectedDate = datePickerEl.value;

  // Validation: date must be chosen
  if (!selectedDate) {
    showError("No Date Selected", "Please pick a date using the calendar before jumping.");
    return;
  }

  // Validation: date must not be in the future
  if (selectedDate > getTodayDateString()) {
    showError(
      "Future Date Selected",
      "The APOD archive only contains entries up to today. Please choose a past date."
    );
    return;
  }

  // Validation: date must be on or after the archive epoch
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
    // Load the chosen date directly into the hero viewer
    await loadApodIntoHero(selectedDate);
  } finally {
    setSearchLoading(false);
  }
}

// ─────────────────────────────────────────────
// 9. UI HELPERS
// ─────────────────────────────────────────────

/**
 * Toggle the search button between active and loading states.
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
 * Show the error banner with a title and detail message.
 * Scrolls it into view automatically.
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
// 10. EVENT LISTENERS & INIT
// ─────────────────────────────────────────────

// "JUMP TO DATE" button
document.getElementById("search-btn").addEventListener("click", handleDatePickerSearch);

// Enter key while the date picker is focused
document.getElementById("date-picker").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleDatePickerSearch();
});

// Error banner close button
document.getElementById("error-close").addEventListener("click", clearError);

// "Shuffle Archive" nav link — loads a fresh batch of 4 random cards
document.getElementById("nav-shuffle-btn").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("archive-section").scrollIntoView({ behavior: "smooth" });
  loadArchiveCards();
});

// Inline "Shuffle" button below the archive grid
document.getElementById("shuffle-btn").addEventListener("click", loadArchiveCards);

// Set the date picker's valid range
const datePickerEl = document.getElementById("date-picker");
datePickerEl.max   = getTodayDateString();
datePickerEl.min   = APOD_EPOCH_START;

// ─────────────────────────────────────────────
// PAGE INITIALISATION
// Two async operations kick off simultaneously on load:
//   1. Hero: today's APOD → full-screen viewer
//   2. Archive: 4 random past entries → browsable card shelf
// Neither blocks the other.
// ─────────────────────────────────────────────
loadApodIntoHero(getTodayDateString());
loadArchiveCards();
