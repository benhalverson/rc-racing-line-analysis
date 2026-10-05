import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LocalRuntime, isLoopbackHost } from './local-runtime';

describe('LocalRuntime', () => {
  it('permits only explicit loopback hosts', () => {
    expect(['localhost', '127.0.0.1', '[::1]'].every(isLoopbackHost)).toBe(true);
    expect(['example.com', 'localhost.example.com', '192.168.1.2', '127.0.0.1.example.com'].some(isLoopbackHost)).toBe(false);
  });

  it('checks capability before sending local video bytes', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const runtime = TestBed.inject(LocalRuntime);
    const http = TestBed.inject(HttpTestingController);
    const file = new File(['synthetic video'], 'race.webm', { type: 'video/webm' });
    const transfer = runtime.importVideo(file);
    http.expectOne('/api/runtime').flush({ mode: 'local-node' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const request = http.expectOne('/api/local-videos');
    expect(request.request.body).toBe(file);
    expect(request.request.headers.get('x-video-name')).toBe('race.webm');
    request.flush({ videoPath: 'local-disk://local-1', localVideoRef: { id: 'local-1' } });
    await expect(transfer).resolves.toMatchObject({ videoPath: 'local-disk://local-1' });
    http.verify();
  });

  it('does not transfer bytes when the runtime has no local capability', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const runtime = TestBed.inject(LocalRuntime);
    const http = TestBed.inject(HttpTestingController);
    const transfer = runtime.importVideo(new File(['video'], 'race.webm'));
    http.expectOne('/api/runtime').flush({ mode: 'cloud' });
    await expect(transfer).rejects.toThrow('localhost Node runtime');
    http.expectNone('/api/local-videos');
    http.verify();
  });
});
