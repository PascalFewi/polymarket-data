// src/utils/helpers.js
// Shared utility functions

/**
 * Chunk an array into fixed-size slices
 * @param {Array} arr - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array<Array>} Array of chunks
 */
export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Compact orderbook levels to save space
 * Converts { price, size } to { p, s }
 * @param {Array} levels - Array of price levels
 * @returns {Array} Compacted levels
 */
export function compactLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels.map((lvl) => {
    if (Array.isArray(lvl)) return lvl;

    if (lvl && typeof lvl === 'object') {
      const { price, size, p, s, ...rest } = lvl;
      const out = { p: p ?? price, s: s ?? size };
      return Object.keys(rest).length ? { ...rest, ...out } : out;
    }

    return lvl;
  });
}

/**
 * Format duration in human-readable form
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Duration in milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a simple logger with timestamps
 * @param {string} prefix - Logger prefix
 * @returns {Object} Logger object
 */
export function createLogger(prefix) {
  const timestamp = () => new Date().toISOString();
  
  return {
    info: (...args) => console.log(`[${timestamp()}] [${prefix}]`, ...args),
    warn: (...args) => console.warn(`[${timestamp()}] [${prefix}] WARN:`, ...args),
    error: (...args) => console.error(`[${timestamp()}] [${prefix}] ERROR:`, ...args),
    debug: (...args) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[${timestamp()}] [${prefix}] DEBUG:`, ...args);
      }
    },
  };
}

export default {
  chunkArray,
  compactLevels,
  formatDuration,
  sleep,
  createLogger,
};
