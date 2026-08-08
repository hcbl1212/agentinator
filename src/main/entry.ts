/**
 * The Electron main-process entry point. Kept separate from index.ts so the
 * module under test has no import-time side effects — importing index.ts
 * must never launch the app or open a database.
 */
import { bootstrap } from './index'

void bootstrap()
