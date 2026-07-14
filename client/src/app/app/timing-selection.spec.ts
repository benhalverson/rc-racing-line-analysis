import { describe, expect, it } from 'vitest';
import type { TimingDriver, TimingEvent, TimingRace, TimingTrack } from './timing-api';
import { buildTimingImportRequest, emptyTimingSelection, selectTimingEvent, selectTimingRace, selectTimingTrack, timingDriverOptionKey, timingImportReadiness } from './timing-selection';

const track: TimingTrack = { host: 'track.liverc.com', name: 'Track', url: 'https://track.liverc.com/' };
const event: TimingEvent = { name: 'Event', url: 'https://track.liverc.com/event' };
const race: TimingRace = { id: '1', label: 'A Main', url: 'https://track.liverc.com/race' };
const driver: TimingDriver = { name: 'Alex Smith', normalizedName: 'alex smith' };

describe('timing selection', () => {
  it('clears all descendants when the track changes', () => {
    const selection = { track, event, race, classLabel: 'Buggy', driver, importedResult: undefined };
    expect(selectTimingTrack(selection, { ...track, url: 'https://other.liverc.com/' })).toMatchObject({ classLabel: '' });
    expect(selectTimingTrack(selection, { ...track, url: 'https://other.liverc.com/' }).event).toBeUndefined();
    expect(selectTimingTrack(selection, { ...track, url: 'https://other.liverc.com/' }).race).toBeUndefined();
    expect(selectTimingTrack(selection, { ...track, url: 'https://other.liverc.com/' }).driver).toBeUndefined();
  });

  it('clears race descendants on event changes and requires a new class on race changes', () => {
    const selection = { track, event, race, classLabel: 'Buggy', driver, importedResult: undefined };
    const eventSelection = selectTimingEvent(selection, { name: 'Other event', url: 'other-event' });
    expect(eventSelection.race).toBeUndefined();
    expect(eventSelection.classLabel).toBe('');
    expect(eventSelection.driver).toBeUndefined();
    expect(selectTimingRace(selection, { ...race, url: 'other-race' }).classLabel).toBe('');
  });

  it('validates readiness and omits nullable IDs from the import payload', () => {
    const selection = { ...emptyTimingSelection(), track, event, race, classLabel: ' Buggy ', driver };
    expect(timingImportReadiness(selection)).toBeUndefined();
    expect(buildTimingImportRequest(selection)).toEqual(expect.objectContaining({ classLabel: ' Buggy ' }));
    expect(buildTimingImportRequest(selection)).toHaveProperty('raceId', '1');
    expect(buildTimingImportRequest(selection)).not.toHaveProperty('driverId');
    expect(timingImportReadiness({ ...selection, classLabel: ' ' })).toContain('class');
  });

  it('gives duplicate unnamed drivers distinct option keys', () => {
    expect(timingDriverOptionKey(driver, 0)).not.toBe(timingDriverOptionKey(driver, 1));
    expect(timingDriverOptionKey({ ...driver, driverId: 'driver-7' }, 0)).toBe('driver-7');
  });
});
