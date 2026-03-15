// src/lib/gamma-api.js
// Polymarket Gamma API client for fetching events and markets

const GAMMA_BASE = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';

/**
 * Fetch JSON from a URL with error handling
 */
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

/**
 * Stream active events from Gamma API, processing each batch immediately
 * This prevents memory exhaustion by not holding all events in memory
 * 
 * @param {Object} options - Options
 * @param {number} options.pageSize - Number of events per page (default: 100)
 * @param {number} options.maxPages - Maximum pages to fetch (default: 50)
 * @param {Function} options.onBatch - Callback for each batch of events
 * @returns {Promise<{totalEvents: number, totalMarkets: number}>} Counts
 */
export async function streamActiveEvents({
  pageSize = 100,
  maxPages = 50,
  onBatch,
} = {}) {
  let offset = 0;
  let totalEvents = 0;
  let totalMarkets = 0;

  for (let i = 0; i < maxPages; i++) {
    const url = `${GAMMA_BASE}/events?closed=false&order=id&ascending=false&limit=${pageSize}&offset=${offset}`;
    const batch = await fetchJSON(url);
    
    if (!Array.isArray(batch) || batch.length === 0) break;

    // Filter to active + not archived
    const filteredEvents = batch.filter((e) => e.active && !e.archived && !e.closed);
    
    if (filteredEvents.length > 0 && onBatch) {
      const marketCount = filteredEvents.reduce((sum, e) => sum + (e.markets?.length || 0), 0);
      await onBatch(filteredEvents, offset, marketCount);
      totalEvents += filteredEvents.length;
      totalMarkets += marketCount;
    }

    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return { totalEvents, totalMarkets };
}

/**
 * Stream recently closed events from Gamma API
 * 
 * @param {Object} options - Options
 * @param {number} options.pageSize - Number of events per page
 * @param {number} options.maxPages - Maximum pages to fetch
 * @param {number} options.daysBack - How many days back to look
 * @param {Function} options.onBatch - Callback for each batch
 * @returns {Promise<{totalEvents: number, totalMarkets: number}>} Counts
 */
export async function streamClosedEvents({
  pageSize = 100,
  maxPages = 10,
  daysBack = 7,
  onBatch,
} = {}) {
  let offset = 0;
  let totalEvents = 0;
  let totalMarkets = 0;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  for (let i = 0; i < maxPages; i++) {
    const url = `${GAMMA_BASE}/events?closed=true&order=id&ascending=false&limit=${pageSize}&offset=${offset}`;
    const batch = await fetchJSON(url);
    
    if (!Array.isArray(batch) || batch.length === 0) break;

    // Only include events closed recently (within daysBack)
    const recentlyClosed = batch.filter((e) => {
      if (!e.endDate && !e.end_time) return false;
      const endDate = new Date(e.endDate ?? e.end_time);
      return endDate >= cutoffDate;
    });

    if (recentlyClosed.length > 0 && onBatch) {
      const marketCount = recentlyClosed.reduce((sum, e) => sum + (e.markets?.length || 0), 0);
      await onBatch(recentlyClosed, offset, marketCount);
      totalEvents += recentlyClosed.length;
      totalMarkets += marketCount;
    }

    // If we've gone past our cutoff date, stop fetching
    if (recentlyClosed.length < batch.length) break;
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return { totalEvents, totalMarkets };
}

/**
 * Extract all markets from an events array
 * Each event has event.markets[] (these become our "markets" table rows)
 * @param {Array} events - Array of events
 * @returns {Array} Array of markets with event_id attached
 */
export function extractMarketsFromEvents(events) {
  const markets = [];
  for (const e of events) {
    const eventId = String(e.id);
    const embedded = e.markets ?? [];
    for (const m of embedded) {
      markets.push({
        ...m,
        event_id: eventId,
      });
    }
  }
  return markets;
}

/**
 * Get outcomes for a Gamma market, with CLOB token IDs
 * @param {Object} market - Market object from Gamma API
 * @returns {Array} Array of { outcome, tokenId, index }
 */
export function getOutcomesForMarket(market) {
  // Outcomes can be string (JSON) or array
  let outcomesRaw = market.outcomes ?? market.shortOutcomes ?? [];
  let outcomes;

  if (Array.isArray(outcomesRaw)) {
    outcomes = outcomesRaw;
  } else if (typeof outcomesRaw === 'string') {
    const trimmed = outcomesRaw.trim();
    if (trimmed.startsWith('[')) {
      try {
        outcomes = JSON.parse(trimmed);
      } catch {
        outcomes = trimmed
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((s) => s.replace(/^"+|"+$/g, '').trim())
          .filter(Boolean);
      }
    } else {
      outcomes = trimmed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } else {
    outcomes = [];
  }

  // clobTokenIds is usually a JSON array string or comma-separated string
  let tokenIdsRaw = market.clobTokenIds ?? market.clob_token_ids ?? '';
  let tokenIds = [];

  if (Array.isArray(tokenIdsRaw)) {
    tokenIds = tokenIdsRaw;
  } else if (typeof tokenIdsRaw === 'string') {
    const trimmed = tokenIdsRaw.trim();
    if (trimmed.startsWith('[')) {
      try {
        tokenIds = JSON.parse(trimmed);
      } catch {
        tokenIds = trimmed
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map((s) => s.replace(/^"+|"+$/g, '').trim())
          .filter(Boolean);
      }
    } else {
      tokenIds = trimmed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return outcomes.map((outcome, i) => ({
    outcome,
    tokenId: tokenIds[i] ?? null,
    index: i,
  }));
}

/**
 * Filter markets by criteria
 * @param {Array} markets - Array of market objects
 * @param {Object} options - Filter options
 * @returns {Array} Filtered markets
 */
export function filterMarkets(
  markets,
  {
    min24hVolume = 0,
    max24hVolume = Infinity,
    requireOrderBook = true,
  } = {}
) {
  return markets.filter((m) => {
    const vol =
      m.volume24hr ??
      m.volume24hrClob ??
      m.volumeNum ??
      Number(m.volume ?? 0) ??
      0;

    if (vol < min24hVolume) return false;
    if (vol > max24hVolume) return false;

    if (requireOrderBook) {
      const enabled =
        m.enableOrderBook ??
        m.enable_order_book ??
        m.liquidityClob !== undefined;
      if (!enabled) return false;
    }

    return true;
  });
}

export default {
  streamActiveEvents,
  streamClosedEvents,
  extractMarketsFromEvents,
  getOutcomesForMarket,
  filterMarkets,
};
