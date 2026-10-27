# Desktop history sync and playback fixes

## Database configuration

The desktop executable starts its own local Next server. Website environment variables are not automatically shared with the installed app. The inspected package has no `POSTGRES_URL`, so `/api/history` and `/api/progress` return 503 with `syncEnabled: false`.

For a **private installation**, configure the same database used by the website in the app's runtime environment. The desktop process now reads `.env` from Electron's `app.getPath('userData')` (normally `%APPDATA%/LibreTV`; the exact folder depends on the application name):

```dotenv
POSTGRES_URL=postgres://<user>:<password>@<host>/<database>?sslmode=require
```

Restart the app after changing it. An inherited `POSTGRES_URL` environment variable also works. Do not commit this file, send credentials to logs, or ship database credentials in a public installer. Public distribution should use an authenticated hosted sync API instead; that architecture is not introduced by this patch.

Login, open history, then verify that authenticated `GET /api/history` and `POST /api/history` / `POST /api/progress` return 200 and records appear in `watch_history` / `watch_progress`. No live database validation was performed.

## Sync reliability

- Pending upserts/deletions/clear operations persist across sessions in local storage.
- Login and network recovery trigger a pull, local-only/newer record backfill, and queue flush.
- Failed uploads retry after 30 seconds; only an explicit missing-database response disables session retries.
- Requests are serialized and acknowledgements remove only the batch actually sent.
- Pending deletes/clear operations are not overwritten by a cloud pull.
- The desktop listening port is saved in `server-port.json` under userData, preserving the browser origin across launches. If that port is occupied, startup fails rather than silently opening an empty storage origin. Previous random-port origins are not automatically migrated.
- Visibility changes trigger a best-effort flush. Forced termination is handled by restoring the persisted queue on next login, not by guaranteeing an exit-time request.

## Playback changes

- Non-cache HLS forward buffer: 30 ? 60 seconds; back buffer: 90 ? 30 seconds.
- Current-episode background prefetch waits until at least 20 seconds are buffered; next-episode prefetch waits for 60 seconds.
- Waiting/seeking throttles both prefetchers. A normal pause allows background caching.
- Default background prefetch concurrency: 3 ? 1; already cached fragments are skipped.
- Episode switches/unmount stop both prefetchers.

This prioritizes active playback at the cost of slower whole-episode/next-episode downloads. Existing in-flight requests are not immediately aborted by throttling. These changes cannot fix a source whose sustained throughput is below its media bitrate. Measure real source throughput and buffering before adding automatic source switching or moving traffic through a hosted proxy.
