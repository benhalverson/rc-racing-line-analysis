import { DecimalPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { AnalysisApi } from './app/analysis-api';
interface Analysis {
  id: string;
  videoName: string;
  carDescription: string | null;
  state: string;
  phase: string;
  progress: number;
  checkpoint: string | null;
}
@Component({
  selector: 'app-root',
  imports: [DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(AnalysisApi);
  readonly videoPath = signal('');
  readonly carDescription = signal('');
  readonly message = signal('');
  readonly analysis = signal<Analysis | undefined>(undefined);
  selectVideo(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.videoPath.set(`local://${file.name}`);
  }
  createDraft() {
    this.api
      .createDraft({
        videoPath: this.videoPath(),
        videoName: this.videoPath().split('/').pop() ?? '',
        carDescription: this.carDescription() || undefined,
      })
      .subscribe({
        next: (value) => {
          this.analysis.set(value);
          this.message.set('Draft saved locally.');
        },
        error: () => this.message.set('Unable to create draft.'),
      });
  }
  queue() {
    this.action('queue');
  }
  start() {
    this.action('start');
  }
  cancel() {
    this.action('cancel');
  }
  private action(action: 'queue' | 'start' | 'cancel') {
    const current = this.analysis();
    if (!current) return;
    this.api
      .action(current.id, action)
      .subscribe({
        next: (value) => this.analysis.set(value),
        error: () => this.message.set('That lifecycle action was not accepted.'),
      });
  }
}
