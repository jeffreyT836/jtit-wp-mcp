import type { FetchLike } from '../../src/wp/client.js';

const range = (from: string, fromInc: boolean, to: string, toInc: boolean) => ({
  from_version: from, from_inclusive: fromInc, to_version: to, to_inclusive: toInc,
});

/** Small Wordfence Intelligence V3 feed in the real shape (object keyed by UUID). */
export const FEED = {
  '848ccbdc-c6f1-480f-a272-cd459e706713': {
    id: '848ccbdc-c6f1-480f-a272-cd459e706713',
    title: 'Contact Form 7 <= 5.8.1 - Reflected Cross-Site Scripting',
    software: [{
      type: 'plugin', name: 'Contact Form 7', slug: 'contact-form-7',
      affected_versions: { '* - 5.8.1': range('*', true, '5.8.1', true) },
      patched: true, patched_versions: ['5.8.2'], remediation: 'Update to version 5.8.2, or a newer patched version',
    }],
    informational: false,
    description: 'The plugin is vulnerable to "Reflected XSS" via the \\"redirect\\" parameter — ü ✓ 🚀',
    references: ['https://www.wordfence.com/threat-intel/vulnerabilities/id/848ccbdc-c6f1-480f-a272-cd459e706713?source=api-prod'],
    cwe: { id: 79, name: 'XSS', description: '' },
    cvss: { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', score: 8.1, rating: 'High' },
    cve: 'CVE-2024-1234',
    cve_link: 'https://www.cve.org/CVERecord?id=CVE-2024-1234',
    researchers: ['Jane {Doe}'],
    published: '2024-01-09 00:00:00',
    updated: '2024-01-10 00:00:00',
    copyrights: { message: 'Copyright 2012-2026 Defiant Inc.', defiant: { notice: 'x', license: 'x', license_url: 'x' } },
  },
  'a1b2c3d4-0000-4000-8000-000000000002': {
    id: 'a1b2c3d4-0000-4000-8000-000000000002',
    title: 'Astra 4.0.0 - 4.6.0 - Missing Authorization',
    software: [{
      type: 'theme', name: 'Astra', slug: 'astra',
      affected_versions: { '4.0.0 - 4.6.0': range('4.0.0', true, '4.6.0', true) },
      patched: true, patched_versions: ['4.6.1'], remediation: null,
    }],
    informational: false,
    references: [],
    cvss: { vector: 'x', score: 4.3, rating: 'Medium' },
    cve: null,
    published: '2024-03-01 12:00:00',
  },
  'a1b2c3d4-0000-4000-8000-000000000003': {
    id: 'a1b2c3d4-0000-4000-8000-000000000003',
    title: 'WordPress Core < 6.8.3 - Stored XSS',
    software: [{
      type: 'core', name: 'WordPress', slug: 'wordpress',
      affected_versions: { '6.8 - 6.8.3': range('6.8', true, '6.8.3', false) },
      patched: true, patched_versions: ['6.8.3'], remediation: 'Update to version 6.8.3',
    }],
    informational: false,
    references: ['https://example.org/core'],
    cvss: { vector: 'x', score: 6.4, rating: 'Medium' },
    cve: 'CVE-2025-0001',
    published: '2025-10-01 00:00:00',
  },
  'a1b2c3d4-0000-4000-8000-000000000004': {
    id: 'a1b2c3d4-0000-4000-8000-000000000004',
    title: 'Contact Form 7 - Informational notice',
    software: [{
      type: 'plugin', name: 'Contact Form 7', slug: 'contact-form-7',
      affected_versions: { '*': range('*', true, '*', true) },
      patched: false, patched_versions: [], remediation: null,
    }],
    informational: true,
    references: [],
    cvss: null,
    cve: null,
    published: null,
  },
  'a1b2c3d4-0000-4000-8000-000000000005': {
    id: 'a1b2c3d4-0000-4000-8000-000000000005',
    title: 'Akismet <= 4.0 - CSRF (not installed version)',
    software: [{
      type: 'plugin', name: 'Akismet', slug: 'akismet',
      affected_versions: { '* - 4.0': range('*', true, '4.0', true) },
      patched: true, patched_versions: ['4.0.1'], remediation: null,
    }],
    informational: false,
    references: [],
    cvss: { vector: 'x', score: 9.8, rating: 'Critical' },
    cve: 'CVE-2020-9999',
    published: '2020-01-01 00:00:00',
  },
};

/** Bytes of `text` split into chunks of `size` (cuts through multibyte characters on purpose). */
export function chunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

export async function* iterate(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield p;
}

export function streamedResponse(text: string, chunkSize = 7, status = 200): Response {
  const parts = chunks(text, chunkSize);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Fake Wordfence endpoint; records every request for assertions. */
export function wordfenceFetch(opts: { status?: number; body?: string; chunkSize?: number } = {}) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return streamedResponse(opts.body ?? JSON.stringify(FEED), opts.chunkSize ?? 7, opts.status ?? 200);
  }) as FetchLike;
  return { fetch, calls };
}
