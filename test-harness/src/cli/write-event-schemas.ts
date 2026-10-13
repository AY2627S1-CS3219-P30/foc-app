/* eslint-disable no-console -- command-line output */
import { writeFileSync } from 'node:fs';
import { EVENT_SCHEMAS_FILE, renderEventSchemas } from '../events.js';

writeFileSync(EVENT_SCHEMAS_FILE, renderEventSchemas());
console.log(`wrote ${EVENT_SCHEMAS_FILE}`);
