import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LocalVideoRef } from '../../../../shared/calibration-contract';

export interface LocalVideoImport { videoPath: string; localVideoRef: LocalVideoRef; }

/** Restricts video transfers to the same machine hosting the browser workspace. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

@Injectable({ providedIn: 'root' })
export class LocalRuntime {
  private readonly http = inject(HttpClient);
  private discovery?: Promise<boolean>;

  /** Discovers the local processing capability without transferring any footage. */
  available(): Promise<boolean> {
    if (!isLoopbackHost(window.location.hostname)) return Promise.resolve(false);
    this.discovery ??= firstValueFrom(this.http.get<{ mode: string }>('/api/runtime'))
      .then((capability) => capability.mode === 'local-node').catch(() => false);
    return this.discovery;
  }

  /** Imports footage only into a verified loopback Node runtime. */
  async importVideo(file: File): Promise<LocalVideoImport> {
    if (!isLoopbackHost(window.location.hostname) || !await this.available()) throw new Error('Local video processing requires the localhost Node runtime.');
    return firstValueFrom(this.http.post<LocalVideoImport>('/api/local-videos', file, {
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-video-name': encodeURIComponent(file.name), 'x-video-last-modified': String(file.lastModified) },
    }));
  }
}

export interface StabilizationReview {
  totalFrames: number;
  usableFrames: number;
  unusableRegions: { startFrame: number; endFrame: number; reason: string }[];
}
