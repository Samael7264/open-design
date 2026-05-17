import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../src/media.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';
const AMR_ENV_KEYS = [
  'AMR_TOKEN',
  'AMR_API_KEY',
  'AMR_GATEWAY_URL',
  'OD_FAL_KEY',
  'FAL_KEY',
];

describe('AMR media bridge', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const originalEnv = Object.fromEntries(
    AMR_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-amr-media-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    for (const key of AMR_ENV_KEYS) delete process.env[key];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    for (const key of AMR_ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('routes image generation through AMR fal-image when no provider key is configured', async () => {
    process.env.AMR_TOKEN = 'amr-token';
    process.env.AMR_GATEWAY_URL = 'https://amr.example.com/';
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://amr.example.com/v1/connectors/fal-image/call');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer amr-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        input: {
          prompt: 'A glass app icon',
          model: 'sd-3.5',
          aspect: '1:1',
        },
      });
      return new Response(JSON.stringify({
        output: { image_url: `data:image/png;base64,${PNG_BASE64}` },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'sd-3.5',
      prompt: 'A glass app icon',
      output: 'amr.png',
    });

    expect(result.providerId).toBe('amr');
    expect(result.providerNote).toContain('amr/fal-image');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bytes = await readFile(path.join(projectsRoot, 'project-1', 'amr.png'));
    expect(bytes.length).toBeGreaterThan(0);
  });
});
