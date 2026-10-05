import type { TrackingArtifacts } from '../../../../shared/tracking-contract';
import type { NormalizedBox } from '../../../../shared/calibration-contract';
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { StabilizationReview } from './local-runtime';
import { Observable } from 'rxjs';
import type { CorrectionSet, CorrectionSetPayload, LocalVideoRef, VideoStorage } from '../../../../shared/calibration-contract';

export interface Analysis {
  id: string;
  videoPath: string;
  videoName: string;
  carDescription: string | null;
  state: string;
  phase: string;
  progress: number;
  checkpoint: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  videoStorage: VideoStorage;
  localVideoRef?: LocalVideoRef;
  acceptedCorrectionSetId: string | null;
}

export type AnalysisConnectionState = 'connected' | 'reconnecting' | 'disconnected';
export interface AnalysisSocketMessage {
  type: 'snapshot' | 'updated';
  analysis: Analysis;
}

@Injectable({
  providedIn: 'root',
})
export class AnalysisApi {
  private readonly http = inject(HttpClient);
  /** Creates a draft with the active runtime storage identity. */
  createDraft(input: {
    videoPath: string;
    videoName: string;
    carDescription?: string;
    videoStorage?: VideoStorage;
    localVideoRef?: LocalVideoRef;
  }): Observable<Analysis> {
    return this.http.post<Analysis>('/api/analyses', input);
  }
  /** Lists saved analyses from the verified local runtime. */
  list() { return this.http.get<{ analyses: Analysis[] }>('/api/analyses'); }
  /** Selects an immutable prior correction version under the currently displayed analysis authority. */
  selectCorrectionSet(analysis: Analysis, correctionSetId: string) {
    return this.http.post<Analysis>(`/api/analyses/${encodeURIComponent(analysis.id)}/correction-sets/${encodeURIComponent(correctionSetId)}/accept`, { updatedAt: analysis.updatedAt, acceptedCorrectionSetId: analysis.acceptedCorrectionSetId });
  }
  startCalibration(id: string) { return this.http.post<Analysis>(`/api/analyses/${id}/calibration/start`, {}); }
  /** Saves new geometry with the editor's displayed optimistic analysis authority. */
  saveCorrectionSet(id: string, payload: CorrectionSetPayload, analysis?: Analysis) { return this.http.post<CorrectionSet>(`/api/analyses/${id}/correction-sets`, payload, analysis ? { headers: { 'x-analysis-updated-at': analysis.updatedAt, 'x-accepted-correction-set-id': analysis.acceptedCorrectionSetId ?? 'null' } } : undefined); }
  correctionSets(id: string) { return this.http.get<{ correctionSets: CorrectionSet[] }>(`/api/analyses/${id}/correction-sets`); }
  /** Reads local persisted stabilization diagnostics for review. */
  artifacts(id: string) { return this.http.get<{ stabilization?: StabilizationReview }>(`/api/analyses/${id}/artifacts`); }
  /** Reads decoded observations from the accepted current local run. */
  tracking(id: string) { return this.http.get<{ tracking?: TrackingArtifacts }>(`/api/analyses/${id}/tracking`); }
  /** Confirms identity with a drawn box; timestamps and file paths come from local evidence. */
  rebox(id: string, frame: number, box: NormalizedBox) { return this.http.post(`/api/analyses/${id}/tracking/rebox`, { frame, box }); }
  get(id: string): Observable<Analysis> {
    return this.http.get<Analysis>(`/api/analyses/${id}`);
  }
  action(id: string, action: 'queue' | 'start' | 'cancel' | 'resume'): Observable<Analysis> {
    return this.http.post<Analysis>(`/api/analyses/${id}/${action}`, {});
  }

  /** Streams browser runtime updates or polls the local Node workflow. */
  updates(id: string, onState: (state: AnalysisConnectionState) => void, localNode = false): Observable<AnalysisSocketMessage> {
    if (localNode) return this.localUpdates(id, onState);
    return new Observable((subscriber) => {
      let socket: WebSocket | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      let stopped = false;
      const terminal = (analysis: Analysis) => ['completed', 'needs_correction', 'failed', 'cancelled'].includes(analysis.state);
      const connect = () => {
        if (stopped) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const currentSocket = new WebSocket(`${protocol}//${window.location.host}/api/analyses/${id}/ws`);
        socket = currentSocket;
        currentSocket.onopen = () => { attempts = 0; onState('connected'); };
        currentSocket.onmessage = (event) => {
          const message = JSON.parse(event.data) as AnalysisSocketMessage;
          subscriber.next(message);
          if (terminal(message.analysis)) subscriber.complete();
        };
        currentSocket.onerror = () => currentSocket.close();
        currentSocket.onclose = () => {
          if (stopped || socket !== currentSocket) return;
          socket = undefined;
          onState('reconnecting');
          const delay = Math.min(5000, 500 * 2 ** attempts++);
          retryTimer = setTimeout(connect, delay);
        };
      };
      connect();
      return () => { stopped = true; if (retryTimer) clearTimeout(retryTimer); socket?.close(); onState('disconnected'); };
    });
  }
  /** Polls persisted workflow state without requiring a cloud WebSocket binding. */
  private localUpdates(id: string, onState: (state: AnalysisConnectionState) => void): Observable<AnalysisSocketMessage> {
    return new Observable((subscriber) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let request: { unsubscribe(): void } | undefined;
      const poll = () => {
        if (stopped) return;
        request = this.get(id).subscribe({
          next: (analysis) => {
            onState('connected');
            subscriber.next({ type: 'updated', analysis });
            if (['completed', 'needs_correction', 'failed', 'cancelled'].includes(analysis.state)) subscriber.complete();
            else timer = setTimeout(poll, 500);
          },
          error: () => { onState('reconnecting'); timer = setTimeout(poll, 1000); },
        });
      };
      poll();
      return () => { stopped = true; if (timer) clearTimeout(timer); request?.unsubscribe(); onState('disconnected'); };
    });
  }

}
