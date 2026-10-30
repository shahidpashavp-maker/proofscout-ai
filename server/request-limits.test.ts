import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import test from 'node:test';
import { createRequestLimiter } from './middleware/request-limits.js';

test('request limits return 429 after the budget and reset at the window boundary', () => {
  let now = 1000;
  const limiter = createRequestLimiter(`test-${Math.random()}`, 2, 60_000, () => now);
  const request = { ip: '127.0.0.1' } as Request;
  let statusCode = 200; let error = '';
  const response = {
    setHeader() { return this; },
    status(code: number) { statusCode = code; return this; },
    json(body: { error: string }) { error = body.error; return this; },
  } as unknown as Response;
  let nextCount = 0;
  const next = (() => { nextCount++; }) as NextFunction;
  limiter(request, response, next);
  limiter(request, response, next);
  assert.equal(nextCount, 2);
  limiter(request, response, next);
  assert.equal(statusCode, 429);
  assert.match(error, /Too many requests/);
  now += 60_000;
  limiter(request, response, next);
  assert.equal(nextCount, 3);
});
