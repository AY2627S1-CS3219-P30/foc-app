/* eslint-disable no-console -- command-line output */
import { writeFileSync } from 'node:fs';
import { MATRIX_FILE, loadTraceability, renderTraceability } from '../traceability.js';

writeFileSync(MATRIX_FILE, renderTraceability(loadTraceability()));
console.log(`wrote ${MATRIX_FILE}`);
