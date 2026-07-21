import { describe, expect, it } from 'vitest';
import { resolveSqliteAssetUrl } from './sqlite-asset-url';

describe('resolveSqliteAssetUrl', () => {
  it.each(['sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'])('resolves %s from the application origin', (file) => {
    expect(resolveSqliteAssetUrl(file, 'https://race.example/app/')).toBe(`https://race.example/${file}`);
  });

  it('preserves unrelated files', () => {
    expect(resolveSqliteAssetUrl('sqlite3.js', 'https://race.example/app/')).toBe('sqlite3.js');
  });
});
