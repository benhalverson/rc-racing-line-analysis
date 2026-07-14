import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

interface Analysis {
  id: string;
  videoName: string;
  carDescription: string | null;
  state: string;
  phase: string;
  progress: number;
  checkpoint: string | null;
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
  }): Observable<Analysis> {
    return this.http.post<Analysis>('/api/analyses', input);
  }
  action(id: string, action: 'queue' | 'start' | 'cancel'): Observable<Analysis> {
    return this.http.post<Analysis>(`/api/analyses/${id}/${action}`, {});
  }
}
