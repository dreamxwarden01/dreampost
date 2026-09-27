import { parentPort, workerData } from 'node:worker_threads';
import { renderMailHtml } from './html-render-core.mjs';

try { parentPort.postMessage({ ok: true, result: renderMailHtml(workerData) }); }
catch (error) { parentPort.postMessage({ ok: false, code: ['html_source_too_large', 'html_structure_too_complex'].includes(error?.message) ? error.message : 'html_render_failed' }); }
