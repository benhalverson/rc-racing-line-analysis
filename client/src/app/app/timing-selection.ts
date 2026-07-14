import type { TimingDriver, TimingEvent, TimingImport, TimingRace, TimingTrack } from './timing-api';
import type { TimingImportRequest } from '../../../../shared/timing-contract';

export type TimingSelection = {
  track?: TimingTrack;
  event?: TimingEvent;
  race?: TimingRace;
  classLabel: string;
  driver?: TimingDriver;
  importedResult?: TimingImport;
};

export const emptyTimingSelection = (): TimingSelection => ({ classLabel: '' });

export function selectTimingTrack(selection: TimingSelection, track: TimingTrack): TimingSelection {
  return { ...selection, track, event: undefined, race: undefined, classLabel: '', driver: undefined, importedResult: undefined };
}

export function selectTimingEvent(selection: TimingSelection, event: TimingEvent): TimingSelection {
  return { ...selection, event, race: undefined, classLabel: '', driver: undefined, importedResult: undefined };
}

export function selectTimingRace(selection: TimingSelection, race: TimingRace): TimingSelection {
  return { ...selection, race, classLabel: '', driver: undefined, importedResult: undefined };
}

export function selectTimingDriver(selection: TimingSelection, driver: TimingDriver): TimingSelection {
  return { ...selection, driver, importedResult: undefined };
}

export function timingImportReadiness(selection: TimingSelection): string | undefined {
  if (!selection.track || !selection.event || !selection.race || !selection.driver) return 'Select a track, event, race, and driver.';
  if (!selection.classLabel.trim()) return 'Enter the LiveRC class exactly as shown.';
  return undefined;
}

export function buildTimingImportRequest(selection: TimingSelection): TimingImportRequest | undefined {
  if (timingImportReadiness(selection)) return undefined;
  const { track, event, race, driver } = selection;
  if (!track || !event || !race || !driver) return undefined;
  return {
    trackHost: track.host,
    trackName: track.name,
    trackUrl: track.url,
    eventName: event.name,
    eventUrl: event.url,
    ...(race.id ? { raceId: race.id } : {}),
    raceLabel: race.label,
    roundLabel: race.label,
    classLabel: selection.classLabel,
    raceUrl: race.url,
    driverName: driver.name,
    ...(driver.driverId ? { driverId: driver.driverId } : {}),
  };
}

export function timingDriverOptionKey(driver: TimingDriver, index: number): string {
  return driver.driverId ?? `${driver.name}-${index}`;
}
