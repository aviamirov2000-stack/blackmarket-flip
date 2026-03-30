const SERVER = "europe";
const BLACK_MARKET = "Black Market";
const MARKET_API_BASE_URL = `https://${SERVER}.albion-online-data.com/api/v2/stats/prices`;
const MARKET_HISTORY_API_BASE_URL = `https://${SERVER}.albion-online-data.com/api/v2/stats/history`;
const OPEN_ALBION_API = "https://api.openalbion.com/api/v3";
const ITEM_SCAN_BATCH_SIZE = 60;
const ITEM_CACHE_KEY = "albion_item_catalog";
const TOP_SCAN_RESULTS = 15;
const SCAN_TIERS = ["T2", "T3", "T4", "T5", "T6", "T7", "T8"];
const SCAN_QUALITIES = ["1", "2", "3"];
const SCAN_ENCHANTMENTS = ["0", "1", "2", "3", "4"];
const DISPLAY_QUALITY = "2";
const REQUEST_RETRY_COUNT = 2;
const REQUEST_RETRY_DELAY_MS = 350;
const MATERIAL_WEIGHT_BY_TIER = {
  4: 0.2125,
  5: 0.3125,
  6: 0.475,
  7: 0.7125,
  8: 1.06875,
};
const ARTIFACT_KEYWORDS = [
  "KEEPER",
  "MORGANA",
  "UNDEAD",
  "DEMONIC",
  "HELL",
  "AVALON",
  "FEY",
  "ROYAL",
  "SHAPESHIFTER",
  "PRIMAL",
];

const fields = {
  buyCity: document.getElementById("buy-city"),
  sellTax: document.getElementById("sell-tax"),
  profitWeightFilter: document.getElementById("profit-weight-filter"),
  sortBy: document.getElementById("sort-by"),
};

const output = {
  status: document.getElementById("status-text"),
  scanStatus: document.getElementById("scan-status"),
  scanResultsBody: document.getElementById("scan-results-body"),
  pageStatus: document.getElementById("page-status"),
};

const scanButton = document.getElementById("scan-button");
const prevPageButton = document.getElementById("prev-page-button");
const nextPageButton = document.getElementById("next-page-button");

let scanRunId = 0;

function getSelectedTiers() {
  return Array.from(document.querySelectorAll('input[name="tierFilter"]:checked'))
    .map((input) => input.value);
}

function getSelectedEnchantments() {
  return Array.from(document.querySelectorAll('input[name="enchantmentFilter"]:checked'))
    .map((input) => input.value);
}

function getActiveEnchantments() {
  const selectedEnchantments = getSelectedEnchantments();
  return selectedEnchantments.length > 0
    ? selectedEnchantments
    : SCAN_ENCHANTMENTS;
}

let allScanResults = [];
let currentPage = 1;

function getProfitWeightFilterPredicate() {
  const filter = fields.profitWeightFilter.value;

  switch (filter) {
    case "0":
      return () => true;
    case "10000-20000":
      return (value) => Number.isFinite(value) && value >= 10000 && value < 20000;
    case "20000-40000":
      return (value) => Number.isFinite(value) && value >= 20000 && value < 40000;
    case "40000-plus":
      return (value) => Number.isFinite(value) && value >= 40000;
    default:
      return () => true;
  }
}

function getVisibleScanResults() {
  const predicate = getProfitWeightFilterPredicate();
  const selectedTiers = getSelectedTiers();
  const activeEnchantments = getActiveEnchantments();

  return sortResults(allScanResults.filter((result) => {
    const resultTier = `T${getTierNumber(result.itemId)}`;
    const tierMatches = selectedTiers.length === 0 || selectedTiers.includes(resultTier);
    const enchantmentMatches = activeEnchantments.length === 0 || activeEnchantments.includes(result.enchantment);
    return tierMatches && enchantmentMatches && predicate(result.profitPerWeight);
  }));
}

function formatSilver(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return `${Math.round(value).toLocaleString("he-IL")} silver`;
}

function formatWeight(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return `${value.toFixed(1)} kg`;
}

function formatSilverPerKg(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return `${Math.round(value).toLocaleString("he-IL")} silver/kg`;
}

function escapeForAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function normalizeBaseItemId(itemId) {
  return itemId.replace(/@\d+$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getQualityLabel(value) {
  return {
    "1": "Normal",
    "2": "Good",
    "3": "Outstanding",
    "4": "Excellent",
    "5": "Masterpiece",
  }[String(value)] ?? `Quality ${value}`;
}

function getTierDisplay(itemId, enchantmentValue) {
  const match = itemId.match(/^T(\d+)/i);
  const tier = match ? match[1] : "?";
  return enchantmentValue === "0" ? tier : `${tier}.${enchantmentValue}`;
}

function getTierNumber(itemId) {
  const match = itemId.match(/^T(\d+)/i);
  return match ? Number(match[1]) : null;
}

function isArtifactItem(itemId) {
  return ARTIFACT_KEYWORDS.some((keyword) => itemId.includes(keyword));
}

function loadCachedItems() {
  try {
    const raw = localStorage.getItem(ITEM_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Array.isArray(cached) && cached.length > 0) return cached;
  } catch { /* ignore corrupt cache */ }
  return null;
}

function saveCachedItems(items) {
  try {
    localStorage.setItem(ITEM_CACHE_KEY, JSON.stringify(items));
  } catch { /* ignore quota errors */ }
}

function clearCachedItems() {
  localStorage.removeItem(ITEM_CACHE_KEY);
}

function parseOpenAlbionItems(apiItems) {
  const seen = new Set();
  const results = [];

  apiItems.forEach((item) => {
    const identifier = item.identifier;
    const name = item.name;

    if (!identifier || !name) return;

    const baseItemId = normalizeBaseItemId(identifier);
    const tier = getTierNumber(baseItemId);

    if (!tier || tier < 2 || tier > 8) return;
    if (isArtifactItem(baseItemId)) return;

    const isCapeOrBag = baseItemId.includes("CAPE") || baseItemId.includes("BAG");
    const isWeaponOrArmor = baseItemId.includes("_MAIN_") || baseItemId.includes("_2H_") || baseItemId.includes("_OFF_")
      || baseItemId.includes("_ARMOR_") || baseItemId.includes("_HEAD_") || baseItemId.includes("_SHOES_");
    if (!isCapeOrBag && !isWeaponOrArmor) return;
    if (seen.has(baseItemId)) return;

    seen.add(baseItemId);
    results.push({ itemId: baseItemId, name });
  });

  return results;
}

async function fetchItemCatalog(statusCallback) {
  const endpoints = ["weapons", "armors", "accessories"];
  const allItems = [];

  const responses = await Promise.all(
    endpoints.map(async (endpoint) => {
      const response = await fetch(`${OPEN_ALBION_API}/${endpoint}`);
      if (!response.ok) {
        throw new Error(`OpenAlbion ${endpoint} fetch failed: ${response.status}`);
      }
      const data = await response.json();
      if (statusCallback) statusCallback(endpoint);
      return data;
    })
  );

  responses.forEach((data) => {
    const items = Array.isArray(data) ? data : (data.data ?? data.items ?? []);
    allItems.push(...items);
  });

  return parseOpenAlbionItems(allItems);
}

async function fetchPriceBatchForQuality(itemIds, quality) {
  const buyCity = fields.buyCity.value;
  const url = `${MARKET_API_BASE_URL}/${encodeURIComponent(itemIds.join(","))}.json?locations=${encodeURIComponent(buyCity)}&qualities=${encodeURIComponent(quality)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Market price batch failed: ${response.status}`);
  }

  return response.json();
}

async function fetchHistoryBatchForQuality(itemIds, quality) {
  const url = `${MARKET_HISTORY_API_BASE_URL}/${encodeURIComponent(itemIds.join(","))}.json?locations=${encodeURIComponent(BLACK_MARKET)}&qualities=${encodeURIComponent(quality)}&time-scale=24`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Market history batch failed: ${response.status}`);
  }

  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPriceBatchWithRetry(itemIds, quality) {
  let lastError = null;

  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchPriceBatchForQuality(itemIds, quality);
    } catch (error) {
      lastError = error;

      if (attempt < REQUEST_RETRY_COUNT) {
        await delay(REQUEST_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError;
}

async function fetchHistoryBatchWithRetry(itemIds, quality) {
  let lastError = null;

  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchHistoryBatchForQuality(itemIds, quality);
    } catch (error) {
      lastError = error;

      if (attempt < REQUEST_RETRY_COUNT) {
        await delay(REQUEST_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError;
}

function getSevenDayAverage(historyEntry) {
  const dataPoints = historyEntry?.data ?? [];
  const lastSeven = dataPoints.slice(-7);

  if (lastSeven.length === 0) {
    return null;
  }

  let weightedValue = 0;
  let totalCount = 0;
  let fallbackValue = 0;
  let fallbackCount = 0;

  lastSeven.forEach((point) => {
    const avgPrice = Number(point.avg_price);
    const itemCount = Number(point.item_count);

    if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
      return;
    }

    if (Number.isFinite(itemCount) && itemCount > 0) {
      weightedValue += avgPrice * itemCount;
      totalCount += itemCount;
    } else {
      fallbackValue += avgPrice;
      fallbackCount += 1;
    }
  });

  if (totalCount > 0) {
    return weightedValue / totalCount;
  }

  if (fallbackCount > 0) {
    return fallbackValue / fallbackCount;
  }

  return null;
}

function getLatestDailySales(historyEntry) {
  const dataPoints = historyEntry?.data ?? [];
  const latestPoint = dataPoints[dataPoints.length - 1];

  if (!latestPoint) {
    return null;
  }

  const itemCount = Number(latestPoint.item_count);
  return Number.isFinite(itemCount) ? itemCount : null;
}

function getLatestDailySalesFromEntries(historyEntries) {
  const total = historyEntries.reduce((sum, entry) => {
    const count = getLatestDailySales(entry);
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);

  return total > 0 ? total : null;
}

function getRecommendedQuantity(latestDailySales) {
  if (!Number.isFinite(latestDailySales) || latestDailySales <= 0) {
    return null;
  }

  return Math.max(1, Math.floor(latestDailySales * 0.3));
}

function getMaterialCountForItem(itemId) {
  if (itemId.includes("_2H_")) {
    return 32;
  }

  if (itemId.includes("_MAIN_")) {
    return 24;
  }

  if (itemId.includes("_OFF_")) {
    return 8;
  }

  if (
    itemId.includes("_ARMOR_PLATE_") ||
    itemId.includes("_ARMOR_LEATHER_") ||
    itemId.includes("_ARMOR_CLOTH_")
  ) {
    return 16;
  }

  if (itemId.includes("BAG_INSIGHT") || itemId.includes("BAG")) {
    return 16;
  }

  if (itemId.includes("CAPEITEM")) {
    return 8;
  }

  if (
    itemId.includes("_SHOES_PLATE_") ||
    itemId.includes("_SHOES_LEATHER_") ||
    itemId.includes("_SHOES_CLOTH_") ||
    itemId.includes("_HEAD_PLATE_") ||
    itemId.includes("_HEAD_LEATHER_") ||
    itemId.includes("_HEAD_CLOTH_")
  ) {
    return 8;
  }

  return null;
}

function estimateItemWeight(itemId) {
  const tier = getTierNumber(itemId);

  if (!tier) {
    return null;
  }

  const materialWeight = MATERIAL_WEIGHT_BY_TIER[tier] ?? null;
  const materialCount = getMaterialCountForItem(itemId);

  if (materialWeight !== null && materialCount !== null) {
    return materialWeight * materialCount;
  }

  return null;
}

function renderPagination(totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / TOP_SCAN_RESULTS));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  output.pageStatus.textContent = `Page ${currentPage} of ${totalPages}`;
  prevPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= totalPages;
}

function renderScanResults(results, emptyMessage = "No profitable sell-order items found for this city.") {
  renderPagination(results.length);

  if (results.length === 0) {
    output.scanResultsBody.innerHTML = `
      <tr>
        <td colspan="9">${escapeHtml(emptyMessage)}</td>
      </tr>
    `;
    return;
  }

  const startIndex = (currentPage - 1) * TOP_SCAN_RESULTS;
  const pageResults = results.slice(startIndex, startIndex + TOP_SCAN_RESULTS);

  output.scanResultsBody.innerHTML = pageResults.map((result, index) => `
    <tr>
      <td>${startIndex + index + 1}</td>
      <td>
        <span class="item-row-header">
          <span>${escapeHtml(result.name)}</span>
          <button
            type="button"
            class="copy-item-button"
            data-copy-text="${escapeForAttribute(result.name)}"
            aria-label="Copy item name"
            title="Copy item name"
          >⧉</button>
        </span><br>
        <span>${escapeHtml(getTierDisplay(result.itemId, result.enchantment))} (${escapeHtml(getQualityLabel(result.quality))})</span>
      </td>
      <td>${formatSilver(result.cityBuyPrice)}</td>
      <td>${formatSilver(result.blackMarketSevenDayAverage)}</td>
      <td>${escapeHtml(`${result.sellTax}%`)}</td>
      <td class="${result.profitPerUnit >= 0 ? "profit-positive" : "profit-negative"}">${formatSilver(result.profitPerUnit)}</td>
      <td class="highlight-cell">${formatSilverPerKg(result.profitPerWeight)}</td>
      <td>${escapeHtml(String(result.recommendedQuantity))}</td>
      <td>${escapeHtml(formatWeight(result.totalEstimatedWeight))}</td>
    </tr>
  `).join("");
}

function getSortConfig() {
  switch (fields.sortBy.value) {
    case "cityBuyPrice":
      return { key: "cityBuyPrice", direction: "asc" };
    case "sellTax":
      return { key: "sellTax", direction: "asc" };
    case "totalEstimatedWeight":
      return { key: "totalEstimatedWeight", direction: "asc" };
    case "blackMarketSevenDayAverage":
      return { key: "blackMarketSevenDayAverage", direction: "desc" };
    case "profitPerUnit":
      return { key: "profitPerUnit", direction: "desc" };
    case "recommendedQuantity":
      return { key: "recommendedQuantity", direction: "desc" };
    case "profitPerWeight":
    default:
      return { key: "profitPerWeight", direction: "desc" };
  }
}

function sortResults(results) {
  const { key, direction } = getSortConfig();

  return [...results]
    .sort((left, right) => {
      const leftValue = Number.isFinite(left[key]) ? left[key] : (direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
      const rightValue = Number.isFinite(right[key]) ? right[key] : (direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);

      if (leftValue === rightValue) {
        return (right.profitPerWeight ?? Number.NEGATIVE_INFINITY) - (left.profitPerWeight ?? Number.NEGATIVE_INFINITY);
      }

      return direction === "asc"
        ? leftValue - rightValue
        : rightValue - leftValue;
    });
}

async function scanBestProfits(forceRefreshItems = false) {
  const currentRunId = ++scanRunId;
  const sellTax = Math.max(0, Number.parseFloat(fields.sellTax.value) || 0);
  const taxMultiplier = 1 - sellTax / 100;

  scanButton.disabled = true;
  currentPage = 1;
  allScanResults = [];
  output.scanStatus.textContent = `Scanning sell-order items for ${fields.buyCity.value}...`;
  output.status.textContent = "Scanning city profits...";
  renderScanResults([], "Scanning items...");

  try {
    let baseItems = forceRefreshItems ? null : loadCachedItems();

    if (baseItems) {
      output.status.textContent = `Loaded ${baseItems.length} items from cache. Fetching prices...`;
    } else {
      output.status.textContent = "Fetching item catalog...";
      baseItems = await fetchItemCatalog((endpoint) => {
        output.status.textContent = `Fetched ${endpoint}...`;
      });
      saveCachedItems(baseItems);
      output.status.textContent = `Found ${baseItems.length} items. Fetching prices...`;
    }

    if (currentRunId !== scanRunId) {
      return;
    }

    const candidates = baseItems.flatMap((item) => SCAN_ENCHANTMENTS.map((enchantment) => ({
      ...item,
      enchantment,
      fullItemId: enchantment === "0" ? item.itemId : `${item.itemId}@${enchantment}`,
    })));

    const totalSteps = Math.ceil(candidates.length / ITEM_SCAN_BATCH_SIZE);
    let completedSteps = 0;
    let allResults = [];

    for (let index = 0; index < candidates.length; index += ITEM_SCAN_BATCH_SIZE) {
      if (currentRunId !== scanRunId) {
        return;
      }

      const batch = candidates.slice(index, index + ITEM_SCAN_BATCH_SIZE);
      let priceRows = [];
      let historyRowsByQuality = [];

      try {
        [priceRows, ...historyRowsByQuality] = await Promise.all([
          fetchPriceBatchWithRetry(batch.map((item) => item.fullItemId), DISPLAY_QUALITY),
          ...SCAN_QUALITIES.map((quality) => fetchHistoryBatchWithRetry(batch.map((item) => item.fullItemId), quality)),
        ]);
      } catch (error) {
        completedSteps += 1;
        output.scanStatus.textContent = `Scanning ${completedSteps} / ${totalSteps} batches...`;
        renderScanResults(getVisibleScanResults(), "Scanning items...");
        continue;
      }

      const displayRowsByItemId = new Map();
      priceRows.forEach((row) => {
        const collection = displayRowsByItemId.get(row.item_id) ?? [];
        collection.push(row);
        displayRowsByItemId.set(row.item_id, collection);
      });

      const historyMapsByQuality = new Map();
      SCAN_QUALITIES.forEach((quality, qualityIndex) => {
        const historyMap = new Map();
        (historyRowsByQuality[qualityIndex] ?? []).forEach((row) => {
          historyMap.set(row.item_id, row);
        });
        historyMapsByQuality.set(quality, historyMap);
      });

      batch.forEach((candidate) => {
        const displayCandidateRows = displayRowsByItemId.get(candidate.fullItemId) ?? [];
        const cityRow = displayCandidateRows.find((row) =>
          row.city === fields.buyCity.value && String(row.quality) === String(DISPLAY_QUALITY)
        );
        const cityBuyPrice = cityRow?.sell_price_min ?? null;
        const displayHistoryEntry = historyMapsByQuality.get(DISPLAY_QUALITY)?.get(candidate.fullItemId) ?? null;
        const blackMarketSevenDayAverage = getSevenDayAverage(displayHistoryEntry);
        const allQualityHistoryEntries = SCAN_QUALITIES.map((scanQuality) =>
          historyMapsByQuality.get(scanQuality)?.get(candidate.fullItemId) ?? null
        ).filter(Boolean);
        const latestDailySales = getLatestDailySalesFromEntries(allQualityHistoryEntries);
        const recommendedQuantity = getRecommendedQuantity(latestDailySales);
        const estimatedItemWeight = estimateItemWeight(candidate.fullItemId);
        const totalEstimatedWeight = estimatedItemWeight === null
          ? null
          : estimatedItemWeight * recommendedQuantity;

        if (
          cityBuyPrice === null ||
          blackMarketSevenDayAverage === null ||
          cityBuyPrice <= 0 ||
          blackMarketSevenDayAverage <= 0 ||
          latestDailySales === null ||
          latestDailySales < 3 ||
          recommendedQuantity === null
        ) {
          return;
        }

        const profitPerUnit = blackMarketSevenDayAverage * taxMultiplier - cityBuyPrice;
        const totalRecommendedProfit = profitPerUnit * recommendedQuantity;
        const profitPerWeight = totalEstimatedWeight && totalEstimatedWeight > 0
          ? totalRecommendedProfit / totalEstimatedWeight
          : null;

        if (profitPerWeight === null) {
          return;
        }

        allResults.push({
          ...candidate,
          quality: DISPLAY_QUALITY,
          sellTax,
          cityBuyPrice,
          blackMarketSevenDayAverage,
          recommendedQuantity,
          totalEstimatedWeight,
          profitPerWeight,
          profitPerUnit,
        });
      });

      completedSteps += 1;

      output.scanStatus.textContent = `Fetching prices: ${completedSteps} / ${totalSteps} batches...`;
      output.status.textContent = `Fetching prices: ${completedSteps} / ${totalSteps}`;
      allScanResults = sortResults(allResults);
      renderScanResults(getVisibleScanResults(), "Scanning items...");
    }

    if (currentRunId !== scanRunId) {
      return;
    }

    allScanResults = sortResults(allResults);
    renderScanResults(getVisibleScanResults());
    output.scanStatus.textContent = getVisibleScanResults().length > 0
      ? `Top ${getVisibleScanResults().length} sell-order items for ${fields.buyCity.value}.`
      : `No profitable sell-order items were found for ${fields.buyCity.value}.`;
    output.status.textContent = "City scan completed.";
  } catch (error) {
    if (currentRunId !== scanRunId) {
      return;
    }

    renderScanResults([], "Could not complete the city scan.");
    output.scanStatus.textContent = `Could not complete the city scan: ${error.message}`;
    output.status.textContent = `Scan failed: ${error.message}`;
  } finally {
    if (currentRunId === scanRunId) {
      scanButton.disabled = false;
    }
  }
}

const refreshItemsButton = document.getElementById("refresh-items-button");

scanButton.addEventListener("click", () => scanBestProfits(false));
refreshItemsButton.addEventListener("click", () => {
  clearCachedItems();
  output.status.textContent = "Item cache cleared. Next scan will re-fetch items.";
});
prevPageButton.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderScanResults(getVisibleScanResults());
  }
});
nextPageButton.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(getVisibleScanResults().length / TOP_SCAN_RESULTS));
  if (currentPage < totalPages) {
    currentPage += 1;
    renderScanResults(getVisibleScanResults());
  }
});
fields.profitWeightFilter.addEventListener("change", () => {
  currentPage = 1;
  renderScanResults(getVisibleScanResults());
});
fields.sortBy.addEventListener("change", () => {
  currentPage = 1;
  renderScanResults(getVisibleScanResults());
});
document.querySelectorAll('input[name="tierFilter"]').forEach((input) => {
  input.addEventListener("change", () => {
    currentPage = 1;
    renderScanResults(getVisibleScanResults());
  });
});
document.querySelectorAll('input[name="enchantmentFilter"]').forEach((input) => {
  input.addEventListener("change", () => {
    currentPage = 1;
    renderScanResults(getVisibleScanResults());
  });
});
output.scanResultsBody.addEventListener("click", async (event) => {
  const copyButton = event.target.closest(".copy-item-button");

  if (!copyButton) {
    return;
  }

  const copyText = copyButton.getAttribute("data-copy-text");

  if (!copyText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(copyText);
    output.status.textContent = `Copied: ${copyText}`;
  } catch (error) {
    output.status.textContent = `Could not copy: ${copyText}`;
  }
});
