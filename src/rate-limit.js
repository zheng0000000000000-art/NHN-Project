import { HttpError } from './utils.js';

export class FixedWindowRateLimiter {
  constructor({ limit = 10, windowMs = 60_000, maxEntries = 10_000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  consume(key, message = 'Too many requests. Try again later.') {
    const now = this.now();
    this.#cleanup(now);
    const normalized = String(key || 'unknown').toLowerCase();
    let entry = this.entries.get(normalized);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { windowStart: now, count: 0, lastSeenAt: now };
    }
    entry.count += 1;
    entry.lastSeenAt = now;
    this.entries.set(normalized, entry);
    if (entry.count > this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000));
      throw new HttpError(429, message, { retryAfterSeconds });
    }
    return { remaining: Math.max(0, this.limit - entry.count) };
  }

  #cleanup(now) {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt >= this.windowMs * 2) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
      .slice(0, this.entries.size - this.maxEntries);
    for (const [key] of oldest) this.entries.delete(key);
  }
}
