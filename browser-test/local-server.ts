import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalServer } from '../api/src/local-server';
startLocalServer(mkdtempSync(join(tmpdir(), 'rc-browser-')), 8787);
