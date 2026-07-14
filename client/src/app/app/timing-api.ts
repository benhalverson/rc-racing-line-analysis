import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { TimingDriver, TimingEvent, TimingImport, TimingImportRequest, TimingImportSummary, TimingRace, TimingTrack } from '../../../../shared/timing-contract';
export type { TimingDriver, TimingEvent, TimingImport, TimingImportRequest, TimingImportSummary, TimingRace, TimingTrack } from '../../../../shared/timing-contract';

@Injectable({ providedIn: 'root' })
export class TimingApi {
  private readonly http = inject(HttpClient);
  tracks(query = ''): Observable<{ tracks: TimingTrack[] }> { return this.http.get<{ tracks: TimingTrack[] }>('/api/timing/tracks', { params: { query } }); }
  events(trackUrl: string): Observable<{ events: TimingEvent[] }> { return this.http.get<{ events: TimingEvent[] }>('/api/timing/events', { params: { trackUrl } }); }
  races(eventUrl: string): Observable<{ races: TimingRace[] }> { return this.http.get<{ races: TimingRace[] }>('/api/timing/races', { params: { eventUrl } }); }
  drivers(raceUrl: string): Observable<{ drivers: TimingDriver[] }> { return this.http.get<{ drivers: TimingDriver[] }>('/api/timing/drivers', { params: { raceUrl } }); }
  import(input: TimingImportRequest): Observable<TimingImport> { return this.http.post<TimingImport>('/api/timing/imports', input); }
  savedImports(limit = 20): Observable<{ imports: TimingImportSummary[] }> { return this.http.get<{ imports: TimingImportSummary[] }>('/api/timing/imports', { params: { limit } }); }
  loadImport(id: string): Observable<TimingImport> { return this.http.get<TimingImport>(`/api/timing/imports/${id}`); }
}
