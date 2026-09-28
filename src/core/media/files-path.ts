/**
 * Path under which `files.routes.ts` is mounted. URLs on the wire are relative
 * to the API host, so they survive the server moving.
 *
 * Its own file because both the service and the local driver build URLs from
 * it, and the driver may not import the service (the service imports the
 * composition that builds the driver).
 */
export const FILES_BASE_PATH = '/api/v1/files';
