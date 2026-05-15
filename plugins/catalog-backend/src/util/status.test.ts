/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { InputError } from '@backstage/errors';
import {
  validateSource,
  validateStatusPayload,
  sanitizeStatus,
} from './status';

describe('validateSource', () => {
  it('accepts valid source names', () => {
    expect(() => validateSource('github')).not.toThrow();
    expect(() => validateSource('my-source')).not.toThrow();
    expect(() => validateSource('source_v2')).not.toThrow();
    expect(() => validateSource('a.b')).not.toThrow();
  });

  it('rejects empty source', () => {
    expect(() => validateSource('')).toThrow(InputError);
  });

  it('rejects source exceeding max length', () => {
    expect(() => validateSource('a'.repeat(129))).toThrow(InputError);
  });

  it('rejects source with spaces', () => {
    expect(() => validateSource('has spaces')).toThrow(InputError);
  });

  it('rejects source with special characters', () => {
    expect(() => validateSource('src!@#')).toThrow(InputError);
  });

  it('rejects source with path traversal', () => {
    expect(() => validateSource('../../etc')).toThrow(InputError);
  });

  it('rejects source that conflicts with reserved status keys', () => {
    expect(() => validateSource('items')).toThrow(InputError);
  });
});

describe('validateStatusPayload', () => {
  it('accepts valid status', () => {
    expect(() => validateStatusPayload({ ok: true })).not.toThrow();
  });

  it('rejects reserved keys', () => {
    expect(() => validateStatusPayload({ items: [] })).toThrow(InputError);
  });

  it('rejects oversized payload', () => {
    const large = { data: 'x'.repeat(65 * 1024) };
    expect(() => validateStatusPayload(large)).toThrow(InputError);
  });
});

describe('sanitizeStatus', () => {
  it('replaces javascript: protocol URLs', () => {
    // eslint-disable-next-line no-script-url
    const status = { url: 'javascript:alert(1)' };
    const result = sanitizeStatus(status);
    expect(result.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });

  it('replaces vbscript: protocol URLs', () => {
    const status = { url: 'vbscript:msgbox("xss")' };
    const result = sanitizeStatus(status);
    expect(result.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });

  it('preserves safe URLs', () => {
    const status = { url: 'https://example.com' };
    const result = sanitizeStatus(status);
    expect(result.url).toBe('https://example.com');
  });

  it('preserves data: image URLs', () => {
    const status = { badge: 'data:image/png;base64,iVBOR' };
    const result = sanitizeStatus(status);
    expect(result.badge).toBe('data:image/png;base64,iVBOR');
  });

  it('sanitizes nested objects', () => {
    // eslint-disable-next-line no-script-url
    const status = { nested: { url: 'javascript:alert(1)' } } as any;
    const result = sanitizeStatus(status);
    expect((result.nested as any).url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });

  it('does not mutate the original object', () => {
    // eslint-disable-next-line no-script-url
    const status = { url: 'javascript:alert(1)' };
    const result = sanitizeStatus(status);
    expect(result).not.toBe(status);
    // eslint-disable-next-line no-script-url
    expect(status.url).toBe('javascript:alert(1)');
    expect(result.url).toBe(
      'https://backstage.io/annotation-rejected-for-security-reasons',
    );
  });
});
