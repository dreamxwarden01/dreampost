export { MailService, validateMailMutation } from './service.js';
export { registerMailRoutes, type MailRouteOptions } from './routes.js';
export { initializeMessageState, indexMessageThread, normalizeMessageId, backfillMailState, type ThreadIndexInput } from './threading.js';
export type { MailViewer, MailListOptions, MailStreamReference, AuthorizeMailTransaction } from './types.js';
