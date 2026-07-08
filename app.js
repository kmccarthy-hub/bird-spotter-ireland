const GBIF_ENDPOINT = "https://api.gbif.org/v1/occurrence/search";
const GBIF_SPECIES_ENDPOINT = "https://api.gbif.org/v1/species";
const PAGE_SIZE = 300;
const MAX_RECORDS = 1500;
const IRELAND_BOUNDS = [
  [51.25, -11.1],
  [55.55, -5.05],
];
const markerColors = ["#2f8f5b", "#e86e54", "#3177b8", "#f4ba46", "#7c5cc4", "#0f766e"];
const COMMON_NAME_OVERRIDES = {
  "Carduelis carduelis": "European Goldfinch",
  "Columba palumbus": "Common Wood Pigeon",
  "Corvus cornix": "Hooded Crow",
  "Cyanistes caeruleus": "Blue Tit",
  "Erithacus rubecula": "European Robin",
  "Fringilla coelebs": "Chaffinch",
  "Hirundo rustica": "Barn Swallow",
  "Larus argentatus": "European Herring Gull",
  "Sturnus vulgaris": "Common Starling",
  "Troglodytes troglodytes": "Eurasian Wren",
  "Turdus merula": "Blackbird",
};

const state = {
  records: [],
  groupedBirds: [],
  selectedBirdKey: null,
  markerBounds: null,
  truncated: false,
  activeRequestId: 0,
  loadedDate: "",
  pendingDateTimer: null,
  commonNameCache: new Map(),
  imageCache: new Map(),
  imageObserver: null,
  scientificNameCache: new Map(),
};

const elements = {
  datePicker: document.querySelector("#datePicker"),
  clearFilter: document.querySelector("#clearFilter"),
  birdList: document.querySelector("#birdList"),
  emptyState: document.querySelector("#emptyState"),
  loadingState: document.querySelector("#loadingState"),
  speciesCount: document.querySelector("#speciesCount"),
  sightingCount: document.querySelector("#sightingCount"),
  recordCount: document.querySelector("#recordCount"),
  selectedBirdLabel: document.querySelector("#selectedBirdLabel"),
};

const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).fitBounds(IRELAND_BOUNDS);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerRenderer = L.canvas({ padding: 0.5 });
const markerLayer = L.layerGroup().addTo(map);

window.addEventListener("resize", () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 250);

function todayIsoDate() {
  return localIsoDate(new Date());
}

function defaultIsoDate() {
  const date = new Date();
  date.setDate(date.getDate() - 14);
  return localIsoDate(date);
}

function localIsoDate(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayName(record) {
  return record.vernacularName || canonicalScientificName(record) || "Unknown bird";
}

function canonicalScientificName(record) {
  return record.species || record.acceptedScientificName || record.scientificName || "";
}

function birdKey(record) {
  return String(record.speciesKey || record.acceptedTaxonKey || record.taxonKey || record.scientificName);
}

function localityText(record) {
  return record.locality || record.stateProvince || record.county || "Location recorded";
}

function countyText(record) {
  const county = record.county || record.stateProvince || "";
  return county.replace(/^County\s+/i, "").trim() || "County unknown";
}

function commonNameKey(record) {
  return record.speciesKey || record.acceptedTaxonKey || record.taxonKey || "";
}

function imageKey(scientificName, taxonKey) {
  return `${taxonKey || "no-key"}:${scientificName || "unknown"}`;
}

async function fetchSightings(date) {
  const records = [];
  let offset = 0;
  let endOfRecords = false;

  while (!endOfRecords && records.length < MAX_RECORDS) {
    const params = new URLSearchParams({
      country: "IE",
      classKey: "212",
      hasCoordinate: "true",
      eventDate: date,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    const response = await fetch(`${GBIF_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`GBIF request failed with ${response.status}`);
    }

    const data = await response.json();
    const pageRecords = (data.results || [])
      .map((record) => ({
        ...record,
        decimalLatitude: Number(record.decimalLatitude),
        decimalLongitude: Number(record.decimalLongitude),
      }))
      .filter(
        (record) =>
          Number.isFinite(record.decimalLatitude) &&
          Number.isFinite(record.decimalLongitude)
      );

    records.push(...pageRecords);
    endOfRecords = Boolean(data.endOfRecords);
    offset += PAGE_SIZE;
  }

  return {
    records: records.slice(0, MAX_RECORDS),
    truncated: !endOfRecords,
  };
}

function groupByBird(records) {
  const birds = new Map();

  records.forEach((record) => {
    const key = birdKey(record);
    if (!birds.has(key)) {
      birds.set(key, {
        key,
        commonNameKey: commonNameKey(record),
        name: displayName(record),
        vernacularCounts: new Map(),
        scientificName: record.species || record.scientificName || "",
        count: 0,
        counties: new Set(),
      });
    }

    const bird = birds.get(key);
    if (record.vernacularName) {
      bird.vernacularCounts.set(
        record.vernacularName,
        (bird.vernacularCounts.get(record.vernacularName) || 0) + 1
      );
    }
    bird.count += 1;
    bird.counties.add(countyText(record));
  });

  return [...birds.values()]
    .map((bird) => ({
      ...bird,
      occurrenceName: mostCommonVernacularName(bird.vernacularCounts),
      location:
        bird.counties.size === 1
          ? [...bird.counties][0]
          : "Multiple Locations",
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function enrichBirdCommonNames(birds) {
  const missingCommonNames = birds.filter(
    (bird) => bird.commonNameKey
  );

  await Promise.all(
    missingCommonNames.map(async (bird) => {
      const overrideName = COMMON_NAME_OVERRIDES[bird.scientificName];
      if (overrideName) {
        bird.name = overrideName;
        return;
      }

      let commonName = await fetchCommonName(bird.commonNameKey);
      if (!commonName || isScientificLikeName(commonName, bird.scientificName)) {
        commonName = await fetchCommonNameByScientificName(bird.scientificName);
      }

      if (commonName && !isScientificLikeName(commonName, bird.scientificName)) {
        bird.name = commonName;
        return;
      }

      if (bird.occurrenceName && !isScientificLikeName(bird.occurrenceName, bird.scientificName)) {
        bird.name = bird.occurrenceName;
        return;
      }

      bird.name = bird.scientificName || bird.name;
    })
  );

  birds.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function mostCommonVernacularName(vernacularCounts) {
  return [...vernacularCounts.entries()]
    .filter(([name]) => isUsefulCommonName(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

async function fetchCommonName(taxonKey) {
  const cacheKey = String(taxonKey);
  if (state.commonNameCache.has(cacheKey)) {
    return state.commonNameCache.get(cacheKey);
  }

  try {
    const response = await fetch(`${GBIF_SPECIES_ENDPOINT}/${cacheKey}/vernacularNames`);
    if (!response.ok) {
      state.commonNameCache.set(cacheKey, "");
      return "";
    }

    const data = await response.json();
    const names = data.results || [];
    const englishNames = names.filter((name) => name.language === "eng");
    const englishName =
      englishNames.find((name) => name.source?.includes("IOC") && isUsefulCommonName(name.vernacularName)) ||
      englishNames.find((name) => name.source?.includes("Clements") && isUsefulCommonName(name.vernacularName)) ||
      englishNames.find((name) => name.source?.includes("Catalogue of Life") && isUsefulCommonName(name.vernacularName)) ||
      englishNames.find((name) => isUsefulCommonName(name.vernacularName));
    const commonName = englishName?.vernacularName || "";
    state.commonNameCache.set(cacheKey, commonName);
    return commonName;
  } catch (error) {
    state.commonNameCache.set(cacheKey, "");
    return "";
  }
}

async function fetchCommonNameByScientificName(scientificName) {
  const cacheKey = String(scientificName || "").trim();
  if (!cacheKey) {
    return "";
  }

  if (state.scientificNameCache.has(cacheKey)) {
    return state.scientificNameCache.get(cacheKey);
  }

  try {
    const matchResponse = await fetch(
      `${GBIF_SPECIES_ENDPOINT}/match?name=${encodeURIComponent(cacheKey)}`
    );
    if (!matchResponse.ok) {
      state.scientificNameCache.set(cacheKey, "");
      return "";
    }

    const match = await matchResponse.json();
    const taxonKey = match.speciesKey || match.usageKey;
    const commonName = taxonKey ? await fetchCommonName(taxonKey) : "";
    state.scientificNameCache.set(cacheKey, commonName);
    return commonName;
  } catch (error) {
    state.scientificNameCache.set(cacheKey, "");
    return "";
  }
}

function isUsefulCommonName(name) {
  const cleanedName = String(name || "").trim();
  const words = cleanedName.split(/\s+/);
  return (
    cleanedName.length >= 4 &&
    /[aeiouy]/i.test(cleanedName) &&
    !/^[A-Z](?:\s+[A-Z])+$/.test(cleanedName) &&
    !/^[A-Z]{2,6}$/.test(cleanedName) &&
    words.length <= 7
  );
}

function isScientificLikeName(name, scientificName) {
  const cleanedName = String(name || "").trim().toLowerCase();
  const cleanedScientificName = String(scientificName || "").trim().toLowerCase();
  return cleanedName === cleanedScientificName || /^[a-z]+ [a-z]+(?:\s|$)/.test(cleanedName);
}

function renderMarkers() {
  markerLayer.clearLayers();
  state.markerBounds = null;

  const visibleRecords = state.selectedBirdKey
    ? state.records.filter((record) => birdKey(record) === state.selectedBirdKey)
    : state.records;
  const birdNames = new Map(state.groupedBirds.map((bird) => [bird.key, bird.name]));

  visibleRecords.forEach((record) => {
    const key = birdKey(record);
    const birdIndex = state.groupedBirds.findIndex((bird) => bird.key === key);
    const color = markerColors[Math.max(birdIndex, 0) % markerColors.length];
    const latLng = [record.decimalLatitude, record.decimalLongitude];
    const marker = L.circleMarker(latLng, {
      renderer: markerRenderer,
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: color,
      fillOpacity: 0.92,
      opacity: 1,
    }).bindTooltip(`
      <p class="popup-title">${escapeHtml(birdNames.get(key) || displayName(record))}</p>
      <p class="popup-meta">
        ${escapeHtml(record.scientificName || "")}<br>
        ${escapeHtml(localityText(record))}<br>
        ${escapeHtml(record.eventDate || elements.datePicker.value)}<br>
        Source: ${escapeHtml(record.datasetName || "GBIF")}
      </p>
    `, {
      direction: "top",
      offset: [0, -8],
      opacity: 0.98,
      sticky: true,
    });

    marker.addTo(markerLayer);
    state.markerBounds = state.markerBounds
      ? state.markerBounds.extend(latLng)
      : L.latLngBounds([latLng]);
  });

  map.invalidateSize();

  if (state.markerBounds) {
    map.fitBounds(state.markerBounds.pad(0.18), { maxZoom: 8 });
  } else {
    map.fitBounds(IRELAND_BOUNDS);
  }

  const showPlus = state.truncated && !state.selectedBirdKey;
  elements.recordCount.textContent = formatSightings(visibleRecords.length, showPlus);
}

function renderBirdList() {
  if (state.imageObserver) {
    state.imageObserver.disconnect();
    state.imageObserver = null;
  }

  elements.birdList.innerHTML = "";
  elements.emptyState.hidden = state.groupedBirds.length > 0;

  const fragment = document.createDocumentFragment();

  state.groupedBirds.forEach((bird) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bird-card${state.selectedBirdKey === bird.key ? " is-active" : ""}`;
    button.innerHTML = `
      <span class="bird-name-row">
        <span class="bird-name">${escapeHtml(bird.name)}</span>
        <span
          class="bird-thumb"
          data-bird-thumb
          data-image-key="${escapeHtml(imageKey(bird.scientificName, bird.commonNameKey))}"
          data-taxon-key="${escapeHtml(bird.commonNameKey)}"
          data-scientific-name="${escapeHtml(bird.scientificName)}"
          aria-hidden="true"
        >
          <span class="bird-thumb-placeholder">B</span>
          <img alt="" loading="lazy" hidden>
        </span>
        <span class="bird-count">${bird.count}</span>
      </span>
      <span class="bird-science">${escapeHtml(bird.scientificName)}</span>
      <span class="bird-locality">${escapeHtml(bird.location)}</span>
    `;
    button.addEventListener("click", () => {
      state.selectedBirdKey = bird.key;
      elements.selectedBirdLabel.textContent = bird.name;
      elements.clearFilter.hidden = false;
      renderBirdList();
      renderMarkers();
    });

    item.append(button);
    fragment.append(item);
  });

  elements.birdList.append(fragment);
  setupLazyBirdImages();
}

function setupLazyBirdImages() {
  const thumbs = [...elements.birdList.querySelectorAll("[data-bird-thumb]")];
  if (!thumbs.length) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    thumbs.forEach((thumb) => loadBirdImage(thumb));
    return;
  }

  state.imageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        state.imageObserver.unobserve(entry.target);
        loadBirdImage(entry.target);
      });
    },
    {
      root: elements.birdList,
      rootMargin: "120px",
      threshold: 0.01,
    }
  );

  thumbs.forEach((thumb) => state.imageObserver.observe(thumb));
}

async function loadBirdImage(thumb) {
  if (thumb.dataset.loaded === "true") {
    return;
  }

  thumb.dataset.loaded = "true";
  const key = thumb.dataset.imageKey;
  const taxonKey = thumb.dataset.taxonKey;
  const scientificName = thumb.dataset.scientificName;

  try {
    const image = await fetchBirdImage({ key, taxonKey, scientificName });
    if (!image?.url || !thumb.isConnected) {
      return;
    }

    const img = thumb.querySelector("img");
    img.src = image.url;
    img.title = image.credit || "";
    img.hidden = false;
    thumb.classList.add("has-image");
  } catch (error) {
    thumb.classList.add("image-missing");
  }
}

async function fetchBirdImage({ key, taxonKey, scientificName }) {
  if (state.imageCache.has(key)) {
    return state.imageCache.get(key);
  }

  const image =
    (await fetchGbifImage(taxonKey)) ||
    (await fetchWikimediaImage(scientificName));

  state.imageCache.set(key, image);
  return image;
}

async function fetchGbifImage(taxonKey) {
  if (!taxonKey) {
    return null;
  }

  try {
    const response = await fetch(`${GBIF_SPECIES_ENDPOINT}/${taxonKey}/media`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const media = (data.results || []).find((item) => {
      const format = String(item.format || "").toLowerCase();
      const type = String(item.type || "").toLowerCase();
      return item.identifier && (type.includes("stillimage") || format.startsWith("image/"));
    });

    if (!media) {
      return null;
    }

    return {
      url: media.identifier,
      credit: cleanCredit(media.creator || media.publisher || "GBIF media"),
    };
  } catch (error) {
    return null;
  }
}

async function fetchWikimediaImage(scientificName) {
  if (!scientificName) {
    return null;
  }

  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${scientificName} bird`,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    iiurlwidth: "96",
    format: "json",
    origin: "*",
  });

  try {
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const pages = Object.values(data.query?.pages || {});
    const imageInfo = pages
      .map((page) => page.imageinfo?.[0])
      .find((info) => info?.thumburl && String(info.mime || "").startsWith("image/"));

    if (!imageInfo) {
      return null;
    }

    const artist = imageInfo.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "");
    const license = imageInfo.extmetadata?.LicenseShortName?.value;

    return {
      url: imageInfo.thumburl,
      credit: cleanCredit([artist, license, "Wikimedia Commons"].filter(Boolean).join(" | ")),
    };
  } catch (error) {
    return null;
  }
}

function cleanCredit(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderSummary() {
  elements.speciesCount.textContent = state.groupedBirds.length;
  elements.sightingCount.textContent = state.truncated ? `${state.records.length}+` : state.records.length;
  elements.recordCount.textContent = formatSightings(state.records.length, state.truncated);
}

function formatSightings(count, showPlus = false) {
  return `${count}${showPlus ? "+" : ""} ${count === 1 ? "sighting" : "sightings"}`;
}

function setLoading(isLoading, text = "") {
  elements.loadingState.textContent = isLoading ? "Loading" : text;
}

async function loadDate(date) {
  if (!isCompleteDate(date) || date === state.loadedDate) {
    return;
  }

  const requestId = state.activeRequestId + 1;
  state.activeRequestId = requestId;
  state.selectedBirdKey = null;
  elements.selectedBirdLabel.textContent = "All birds";
  elements.clearFilter.hidden = true;
  setLoading(true);
  elements.emptyState.hidden = true;
  elements.birdList.innerHTML = "";

  try {
    const result = await fetchSightings(date);
    if (requestId !== state.activeRequestId) {
      return;
    }

    state.records = result.records;
    state.truncated = result.truncated;
    state.groupedBirds = groupByBird(state.records);
    await enrichBirdCommonNames(state.groupedBirds);
    if (requestId !== state.activeRequestId) {
      return;
    }

    state.loadedDate = date;
    renderSummary();
    renderBirdList();
    renderMarkers();
    setLoading(false, state.records.length ? (state.truncated ? "Limited" : "Live") : "No sightings");
  } catch (error) {
    if (requestId !== state.activeRequestId) {
      return;
    }

    console.error("Unable to load sightings", error);
    state.records = [];
    state.groupedBirds = [];
    state.truncated = false;
    state.loadedDate = "";
    renderSummary();
    renderBirdList();
    renderMarkers();
    elements.emptyState.hidden = false;
    elements.emptyState.textContent = "The sightings feed is taking a short rest. Try again in a moment.";
    setLoading(false, "Error");
  }
}

function isCompleteDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

elements.datePicker.value = defaultIsoDate();
elements.datePicker.max = todayIsoDate();

function handleDatePickerUpdate() {
  window.clearTimeout(state.pendingDateTimer);
  elements.emptyState.textContent = "Nothing flying around out there on this day";
  state.pendingDateTimer = window.setTimeout(() => {
    loadDate(elements.datePicker.value);
  }, 250);
}

elements.datePicker.addEventListener("input", handleDatePickerUpdate);
elements.datePicker.addEventListener("change", handleDatePickerUpdate);

function clearSelectedBird() {
  state.selectedBirdKey = null;
  elements.selectedBirdLabel.textContent = "All birds";
  elements.clearFilter.hidden = true;
  renderBirdList();
  renderMarkers();
}

elements.clearFilter.addEventListener("click", () => {
  clearSelectedBird();
});

loadDate(elements.datePicker.value);
