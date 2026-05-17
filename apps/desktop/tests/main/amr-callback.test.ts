import { describe, expect, it } from 'vitest';

import {
  forwardAmrCallbackUrl,
  isAmrCallbackUrl,
} from '../../src/main/amr-callback.js';

describe('AMR callback protocol', () => {
  it('recognizes open-design AMR callback URLs', () => {
    expect(
      isAmrCallbackUrl('open-design://amr-callback?token=t&gateway=http%3A%2F%2F127.0.0.1%3A8787'),
    ).toBe(true);
    expect(isAmrCallbackUrl('open-design://other?token=t')).toBe(false);
    expect(isAmrCallbackUrl('od://app/')).toBe(false);
  });

  it('forwards callback query fields to the daemon integration endpoint', async () => {
    const captured: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.push({
        url: input instanceof URL ? input.toString() : String(input),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const ok = await forwardAmrCallbackUrl(
      'open-design://amr-callback?token=amr-token&gateway=https%3A%2F%2Famr.example.com&org_id=org-1',
      'http://127.0.0.1:7456/',
      fetchImpl,
    );

    expect(ok).toBe(true);
    expect(captured).toEqual([
      {
        url: 'http://127.0.0.1:7456/api/integrations/amr/callback',
        body: {
          token: 'amr-token',
          gateway: 'https://amr.example.com',
          org_id: 'org-1',
        },
      },
    ]);
  });
});
