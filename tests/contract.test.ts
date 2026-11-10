import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { closePool } from '../src/db/pool';
import { app } from './helpers';

type Method = 'get' | 'post' | 'patch' | 'delete';

const spec = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../openapi.yaml'), 'utf8')) as {
  paths: Record<string, Partial<Record<Method, { security?: unknown[] }>>>;
};

const operations = Object.entries(spec.paths).flatMap(([route, ops]) =>
  (Object.keys(ops) as Method[]).map((method) => ({
    method,
    route,
    isPublic: Array.isArray(ops[method]!.security),
  })),
);

afterAll(async () => {
  await closePool();
});

describe('OpenAPI contract', () => {
  it('documents every endpoint in the contract', () => {
    expect(operations).toHaveLength(51);
  });

  it.each(operations)('$method $route is implemented', async ({ method, route, isPublic }) => {
    const url = `/api/v1${route.replace('{id}', '1')}`;
    const res = await request(app)[method](url).set('Authorization', 'Bearer not-a-real-token').send({});
    // An unknown route answers 404 "Route … not found"; a real one rejects the bogus token (401),
    // or for public routes, the empty body (400) — or succeeds (health).
    expect(res.body.error?.message ?? '').not.toMatch(/^Route /);
    if (isPublic) {
      expect([200, 400, 503]).toContain(res.status);
    } else {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });
});
