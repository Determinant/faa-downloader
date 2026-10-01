/** Validators distinguish invalid source bytes from I/O or tool failures.
 * Only invalid bytes authorize fetching a replacement for an existing cache. */
export class InvalidDownloadError extends Error {}
