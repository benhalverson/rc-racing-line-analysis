import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

export interface TimingTrack { host: string; name: string; url: string; }
export interface TimingEvent { name: string; url: string; }
export interface TimingRace { id: string | null; label: string; url: string; }
export interface TimingDriver { name: string; normalizedName: string; }
export interface TimingLap { lapNumber: number; lapTimeSeconds: number | null; lapTimeText: string; valid: boolean | null; statusText: string | null; }
export interface TimingImport {
  id: string; trackHost: string; trackName: string; trackUrl: string; eventName: string; eventUrl: string;
  raceId: string | null; raceLabel: string; roundLabel: string; classLabel: string; raceUrl: string;
  driverName: string; normalizedDriverName: string; fetchedAt: string; laps: TimingLap[];
}

@Injectable({ providedIn: 'root' })
export class TimingApi {
  private readonly http = inject(HttpClient);
  tracks(query = ''): Observable<{ tracks: TimingTrack[] }> { return this.http.get<{ tracks: TimingTrack[] }>('/api/timing/tracks', { params: { query } }); }
  events(trackUrl: string): Observable<{ events: TimingEvent[] }> { return this.http.get<{ events: TimingEvent[] }>('/api/timing/events', { params: { trackUrl } }); }
  races(eventUrl: string): Observable<{ races: TimingRace[] }> { return this.http.get<{ races: TimingRace[] }>('/api/timing/races', { params: { eventUrl } }); }
  drivers(raceUrl: string): Observable<{ drivers: TimingDriver[] }> { return this.http.get<{ drivers: TimingDriver[] }>('/api/timing/drivers', { params: { raceUrl } }); }
  import(input: Record<string, string>): Observable<TimingImport> { return this.http.post<TimingImport>('/api/timing/imports', input); }
}
