import { LocalTimingStore } from '../api/src/local-timing-store';
import { reviewTimingFixture } from './timing-fixture';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalServer } from '../api/src/local-server';
const runtime = startLocalServer(mkdtempSync(join(tmpdir(), 'rc-browser-')), 8787);
await new LocalTimingStore(runtime.persistence.db).saveTimingImport(reviewTimingFixture);
