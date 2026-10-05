const SQLITE_ASSETS = new Set(['sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']);

export function resolveSqliteAssetUrl(file: string, origin: string): string {
  return SQLITE_ASSETS.has(file) ? new URL(`/${file}`, origin).href : file;
}
