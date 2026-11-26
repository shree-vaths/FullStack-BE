import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseCorsOrigins } from '../src/corsOrigins';
import { seedDatabase } from '../src/db/seedData';
import { createTestDb, resetSchema, type TestDb } from './testDb';

const FRONTEND = 'https://fullstack-fe.onrender.com';
const STRANGER = 'https://evil.example.com';

describe('parseCorsOrigins', () => {
  it('parses a comma-separated list, trimming spaces and trailing slashes', () => {
    expect(parseCorsOrigins(' https://a.com/ , http://localhost:5173 ')).toEqual([
      'https://a.com',
      'http://localhost:5173',
    ]);
  });

  it('treats an empty value as "no cross-origin access"', () => {
    expect(parseCorsOrigins('')).toEqual([]);
  });

  it.each([
    ['*', /not "\*"/],
    ['fullstack-fe.onrender.com', /Invalid origin/], // missing scheme
    ['https://a.com/app', /must not have a path/],
  ])('rejects %s', (value, message) => {
    expect(() => parseCorsOrigins(value)).toThrow(message);
  });
});

describe('CORS', () => {
  let db: TestDb;
  let app: Express;

  beforeAll(async () => {
    db = await createTestDb();
    await resetSchema(db);
    await seedDatabase(db, { userCount: 3, transactionCount: 30 });
    app = createApp(db, { corsOrigins: [FRONTEND] });
  });

  afterAll(async () => {
    await db.close();
  });

  it('allows the configured frontend origin', async () => {
    const res = await request(app).get('/api/users').set('Origin', FRONTEND).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    // The client's retry logic must be able to read Retry-After cross-origin.
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('gives other origins no CORS headers, so browsers block them', async () => {
    const res = await request(app).get('/api/users').set('Origin', STRANGER);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds CORS headers to error responses too, so the browser can read them', async () => {
    const res = await request(app).get('/api/users/999').set('Origin', FRONTEND).expect(404);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers preflight requests for GET', async () => {
    const res = await request(app)
      .options('/api/users')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-methods']).toBe('GET');
  });

  it('allows no cross-origin access when no origins are configured', async () => {
    const sameOriginOnly = createApp(db);
    const res = await request(sameOriginOnly).get('/api/users').set('Origin', FRONTEND).expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
