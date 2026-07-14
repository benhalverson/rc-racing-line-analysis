export type TimingTrack = {
  host: string;
  name: string;
  url: string;
};

export type TimingEvent = {
  name: string;
  url: string;
};

export type TimingRace = {
  id: string;
  label: string;
  url: string;
};

export type TimingDriver = {
  name: string;
  normalizedName: string;
  driverId?: string;
};

export type TimingLap = {
  lapNumber: number;
  lapTimeSeconds: number | null;
  lapTimeText: string;
  valid: boolean | null;
  statusText: string | null;
};

export type TimingImportRequest = {
  trackHost: string;
  trackName: string;
  trackUrl: string;
  eventName: string;
  eventUrl: string;
  raceId?: string | null;
  raceLabel: string;
  roundLabel: string;
  classLabel: string;
  raceUrl: string;
  driverName: string;
  driverId?: string | null;
};

export type TimingImport = {
  id: string;
  source: "liverc";
  trackHost: string;
  trackName: string;
  trackUrl: string;
  eventName: string;
  eventUrl: string;
  raceId: string | null;
  raceLabel: string;
  roundLabel: string;
  classLabel: string;
  raceUrl: string;
  driverName: string;
  normalizedDriverName: string;
  driverId: string | null;
  fetchedAt: string;
  parserVersion: string;
  sourceHash: string;
  laps: TimingLap[];
};

export type TimingImportSummary = Pick<TimingImport, 'id' | 'source' | 'trackName' | 'eventName' | 'raceLabel' | 'classLabel' | 'driverName' | 'driverId' | 'fetchedAt' | 'raceId'>;
