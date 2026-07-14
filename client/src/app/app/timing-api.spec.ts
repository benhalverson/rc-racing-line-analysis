import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TimingApi } from './timing-api';

describe('TimingApi', () => {
  it('sends the selected track URL when loading archived events', () => {
    TestBed.configureTestingModule({ providers: [TimingApi, provideHttpClient(), provideHttpClientTesting()] });
    const api = TestBed.inject(TimingApi);
    const http = TestBed.inject(HttpTestingController);
    api.events('https://norcalhobbies.liverc.com/').subscribe();
    const request = http.expectOne((candidate) => candidate.url === '/api/timing/events');
    expect(request.request.params.get('trackUrl')).toBe('https://norcalhobbies.liverc.com/');
    request.flush({ events: [] });
    http.verify();
  });
});
