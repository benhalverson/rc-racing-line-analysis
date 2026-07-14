import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
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
  createDraft(input: {
    videoPath: string;
    videoName: string;
    carDescription?: string;
    videoStorage?: 'browser-sqlite';
    localVideoRef?: LocalVideoRef;
  }): Observable<Analysis> {
    return this.http.post<Analysis>('/api/analyses', input);
  }
  startCalibration(id: string) { return this.http.post<Analysis>(`/api/analyses/${id}/calibration/start`, {}); }
  saveCorrectionSet(id: string, payload: CorrectionSetPayload) { return this.http.post<CorrectionSet>(`/api/analyses/${id}/correction-sets`, payload); }
  correctionSets(id: string) { return this.http.get<{ correctionSets: CorrectionSet[] }>(`/api/analyses/${id}/correction-sets`); }
  get(id: string): Observable<Analysis> {
    return this.http.get<Analysis>(`/api/analyses/${id}`);
  }
  action(id: string, action: 'queue' | 'start' | 'cancel' | 'resume'): Observable<Analysis> {
    return this.http.post<Analysis>(`/api/analyses/${id}/${action}`, {});
  }

  updates(id: string, onState: (state: AnalysisConnectionState) => void): Observable<AnalysisSocketMessage> {
    return new Observable((subscriber) => {
      let socket: WebSocket | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      let stopped = false;
      const terminal = (analysis: Analysis) => ['completed', 'failed', 'cancelled'].includes(analysis.state);
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
}
