import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisApi, type Analysis } from './analysis-api';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.onopen?.();
  }

  send() {}

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }

  close() {
    this.onclose?.();
  }
}

const analysis = (state: string): Analysis => ({
  id: 'analysis-1',
  videoPath: '/race.mp4',
  videoName: 'race.mp4',
  carDescription: null,
  state,
  phase: state === 'completed' ? 'review' : 'tracking',
  progress: state === 'completed' ? 1 : 0.5,
  checkpoint: state === 'completed' ? 'completed' : 'tracking-halfway',
  error: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  videoStorage: 'browser-sqlite',
  localVideoRef: { id: 'video-1', name: 'race.mp4', mimeType: 'video/mp4', size: 1, lastModified: 1 },
  acceptedCorrectionSetId: null,
});

describe('AnalysisApi live updates', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it('emits snapshots and progress updates over one WebSocket connection', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const api = TestBed.configureTestingModule({
      providers: [provideHttpClient()],
    }).inject(AnalysisApi);
    const messages: string[] = [];
    const states: string[] = [];
    const subscription = api.updates('analysis-1', (state) => states.push(state)).subscribe((message) => {
      messages.push(`${message.type}:${message.analysis.state}`);
    });
    const socket = FakeWebSocket.instances[0];

    socket.open();
    socket.message({ type: 'snapshot', analysis: analysis('running') });
    socket.message({ type: 'updated', analysis: analysis('completed') });

    expect(socket.url).toContain('/api/analyses/analysis-1/ws');
    expect(messages).toEqual(['snapshot:running', 'updated:completed']);
    expect(states).toEqual(['connected', 'disconnected']);
    expect(subscription.closed).toBe(true);
  });

  it('reconnects after an unexpected close without issuing status requests', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const api = TestBed.configureTestingModule({
      providers: [provideHttpClient()],
    }).inject(AnalysisApi);
    const states: string[] = [];
    const get = vi.spyOn(api, 'get').mockReturnValue(of(analysis('running')));
    const subscription = api.updates('analysis-1', (state) => states.push(state)).subscribe();
    const first = FakeWebSocket.instances[0];

    first.open();
    first.close();
    vi.advanceTimersByTime(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(states).toEqual(['connected', 'reconnecting']);
    expect(get).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });
});
