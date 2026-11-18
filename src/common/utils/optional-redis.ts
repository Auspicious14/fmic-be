import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis is only a cache here, so it must never break or slow down a request.
 * - No REDIS_URL -> no Redis at all.
 * - Redis unreachable -> commands fail instantly (no offline queue) and the
 *   error is logged once a minute instead of flooding the logs with
 *   "[ioredis] Unhandled error event".
 */
export function createOptionalRedis(
  url: string | undefined,
  logger: Logger,
): Redis | null {
  if (!url) return null;

  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    // Back off up to 30s between reconnect attempts.
    retryStrategy: (times) => Math.min(times * 2000, 30000),
  });

  let lastLoggedAt = 0;
  redis.on('error', (error: Error) => {
    if (Date.now() - lastLoggedAt > 60000) {
      lastLoggedAt = Date.now();
      logger.warn(
        `Redis unavailable (caching skipped): ${error.message}. Remove REDIS_URL if you don't use Redis.`,
      );
    }
  });
  Promise.resolve()
    .then(() => redis.connect())
    .catch(() => {
      /* reported by the 'error' handler above */
    });

  return redis;
}
