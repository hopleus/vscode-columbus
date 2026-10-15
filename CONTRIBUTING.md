# Contributing

## Setup

```sh
npm install
npm run build        # bundle the extension and the webview into out/
npm run watch        # rebuild on changes
npm run typecheck    # tsc for the extension and the webview, no emit
npm run lint         # ESLint
npm run test:unit    # node:test; database tests run when COLUMBUS_PG_URL / COLUMBUS_MYSQL_URL / COLUMBUS_REDIS_URL are set
npm run test:integration   # downloads VS Code, runs the extension in it
npm run package      # .build/vscode-columbus-<version>.vsix, see scripts/package.mjs
```

`npm run package` copies the files `vsce` would pack into `.build/vsix`, minifies `package.json`, JSON grammars and SVG icons there, strips source map references from the bundles (already minified by esbuild) and packs the `.vsix` from that folder.

Press F5 to start the Extension Development Host. The demo data source is registered only outside production mode.

Database tests create and drop the `columbus_test` schema:

```sh
docker run -d --rm --name columbus-pg -e POSTGRES_PASSWORD=columbus -e POSTGRES_DB=columbus -p 55432:5432 postgres:18-alpine
docker run -d --rm --name columbus-mysql -e MYSQL_ROOT_PASSWORD=columbus -p 53306:3306 mysql:8.0
docker run -d --rm --name columbus-redis -p 56379:6379 redis:7.4-alpine
npm run build
COLUMBUS_PG_URL=postgresql://postgres:columbus@localhost:55432/columbus \
COLUMBUS_MYSQL_URL=mysql://root:columbus@127.0.0.1:53306 \
COLUMBUS_REDIS_URL=redis://localhost:56379/0 npm run test:unit
```

SQLite and SSH tests need no server: the SSH tests start an SSH server of `ssh2` in the test process, sign in with a password, key files and a temporary `ssh-agent`, and resolve the host names `node-<port>` and `redis-<name>` to 127.0.0.1 for the tunnels.

Redis Cluster and Sentinel tests need the setups that `test/topologies.sh` starts in Docker: plain and TLS clusters and Sentinels, a Sentinel with a replica for failover, a cluster with a spare node, and copies whose nodes announce host names only the test SSH server resolves. The script writes a test CA and node certificates to the given directory and prints the variables that enable the tests:

```sh
sh test/topologies.sh /tmp/columbus-topologies > /tmp/columbus-topologies.env
set -a; . /tmp/columbus-topologies.env; set +a
npm run build && npm run test:unit
docker rm -f $(docker ps -aq --filter name=columbus-topology-)
```

TLS tests need `test/tls.sh`: PostgreSQL, MySQL and Redis with a certificate of a test CA valid for `127.0.0.1` and `db-secure` but not `localhost`, and users that sign in with a client certificate. Run it the same way and stop its containers with `docker rm -f $(docker ps -aq --filter name=columbus-tls-)`.

## Layout

- `src/extension.ts` – activation and commands
- `src/catalog.ts` – catalog model: databases, schemas, tables, columns, keys, indexes
- `src/sources.ts` – registered data sources and their cached catalogs
- `src/drivers/driver.ts` – the driver interface; `src/drivers/demo.ts` – in-memory demo driver
- `src/drivers/postgres.ts` – PostgreSQL driver, bundled with `pg` into `out/drivers/postgres.js`
- `src/drivers/mysql.ts` – MySQL / MariaDB driver, bundled with `mysql2` into `out/drivers/mysql.js`
- `src/drivers/sql.ts` – dialects and the UPDATE / INSERT / DELETE builder
- `src/drivers/remote.ts` – proxy that runs a driver bundle in `src/worker/main.ts` on a worker thread
- `src/assist` – SQL grammar analysis on `dt-sql-parser` (`engine.ts`), bundled per dialect into `out/assist/{postgres,mysql}.js`, downloaded like the drivers and run in `src/assist/worker.ts` on a worker thread
- `src/drivers/ssh.ts` – SSH tunnel on `ssh2`, bundled into `out/drivers/ssh.js` and downloaded with the server drivers; `src/worker/main.ts` opens it before the driver when a data source has `ssh`
- `src/drivers/sqlite.ts` – SQLite driver on the built-in `node:sqlite` (Node.js 22.16 or newer), bundled into `out/drivers/sqlite.js`; its tests run without a server
- `src/drivers/redis.ts` – Redis / Valkey / Dragonfly driver, bundled with `iovalkey` into `out/drivers/redis.js` and called through `RemoteRedis`; `src/redis` – keys in the grid and as text (`keys.ts`), value and command conversion (`values.ts`), the Redis console (`console.ts`) and tree actions (`actions.ts`)
- `src/drivers/files.ts`, `src/drivers/install.ts`, `src/drivers/manage.ts` – driver files: `out/drivers` when running from source, otherwise verified files in global storage that are downloaded or installed only on request (Download in the form and the tree, Manage Drivers); `COLUMBUS_RELEASE_URL` points a development build at another release, e.g. a local `python3 -m http.server`
- `src/store.ts` – saved data sources and passwords (secret storage); `src/storage.ts` – where data sources, schema filters and consoles live: project ones in `.columbus` of the first workspace folder (ignored in git by its own `.gitignore`) or in VS Code workspace storage with `columbus.storage: internal`, global ones in `state.json` of the global storage folder of the extension, where the `globalState` of 0.1.0 is imported once; `src/file-state.ts` keeps such a `state.json`, written atomically and read again when another window changes it
- `src/explorer/tree.ts` – the Project and Global trees of Database Explorer
- `src/editor/panel.ts` – data editor webview panel, talks to the driver
- `src/console` – query consoles: files and execution (`consoles.ts`), completion (`assist.ts` heuristics, `smart.ts` on top of the grammar analysis from `assist-client.ts`), name resolution for highlighting, problems and `*` expansion (`semantics.ts`, wired into VS Code by `language.ts`), result paging (`paging.ts`), the results panel (`results.ts`)
- `src/editor/export.ts` – export to a file, shared by tables and query results
- `src/forms/source-form.ts` – data source form panel: test connection, save to the store
- `src/webview` – UI running inside webviews (separate tsconfig with DOM types): `data-view.ts` is the toolbar, grid and pager used by both the data editor (`main.ts`) and the results panel (`results.ts`), `form.ts` is the data source form built with [vscode-elements](https://vscode-elements.github.io)
- `src/shared` – code used by both sides: message protocol, pending changes, formatting
- `resources/icons` – tree icons for light and dark themes
- `src/test` – unit tests, `src/test/integration` – tests running inside VS Code: `editor.test.ts` in a window without a folder, `project.test.ts` in a project with a `.columbus` folder

## Releasing

Everything lives in `main`. Changes go in through pull requests, and releases are built from tags on `main`.

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Merge the change into `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v<version>
   git push origin v<version>
   ```

The `Release` workflow checks that the tag matches `package.json` and points to a commit on `main`, runs the tests, builds a single `.vsix` and attaches it to a GitHub release together with the driver bundles (`columbus-driver-<name>.js`) and the completion engines (`columbus-assist-<dialect>.js`).

Driver bundles are not packed into the `.vsix`. The build writes their SHA-256 checksums, sizes and library versions to `out/drivers.json`, which is packed, and the installed extension downloads `releases/download/v<version>/columbus-driver-<name>.js` when the user asks for it. The checksums only match the files of the same build, so publish the `.vsix` from the release (`vsce publish --packagePath vscode-columbus-<version>.vsix`), and the repository and the release must be public before the version is published to the Marketplace.
