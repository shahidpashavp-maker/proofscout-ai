import type { Request, Response, NextFunction, RequestHandler } from 'express';

type Window = { startedAt: number; count: number };
const windows = new Map<string, Window>();

export function createRequestLimiter(name: string, limit: number, windowMs: number, now = () => Date.now()): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const current = now();
    const key = `${name}:${request.ip}`;
    let window = windows.get(key);
    if (!window || current - window.startedAt >= windowMs) {
      window = { startedAt: current, count: 0 };
      windows.set(key, window);
    }
    window.count++;
    if (windows.size > 10_000) {
      for (const [entryKey, entry] of windows) if (current - entry.startedAt >= windowMs) windows.delete(entryKey);
    }
    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, limit - window.count)));
    if (window.count > limit) {
      response.setHeader('Retry-After', String(Math.ceil((windowMs - (current - window.startedAt)) / 1000)));
      return response.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }
    return next();
  };
}
