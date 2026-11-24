# db-desk

A desktop app (Electron + TypeScript) to browse and manage SQL databases on your server.
Supports PostgreSQL, MySQL / MariaDB and SQL Server. Each engine is a driver in `src/main/db/`.

## Features

- Save connections (host, port, user, password, database, SSL). Passwords are encrypted with the OS keychain and stay on your computer.
- Optional built-in SSH tunnel (password or private key), so a database that is closed to the internet can be reached without a separate terminal. With a tunnel, Host/Port are the database address as seen from the SSH server (usually 127.0.0.1:5432).
- See all tables, their sizes, and the total database size.
- Browse table data with paging.
- Add a row, delete a row (by primary key), drop a table.
- Every delete asks for confirmation. Dropping a table requires typing the table name.
- Backup to a `.sql` file: `pg_dump` (PostgreSQL), `mysqldump` (MySQL/MariaDB), or a data-only INSERT export (SQL Server).

## Run

```
npm install
npm start
```

Backup needs the matching client tool on your PATH: `pg_dump` (same version as the server or newer) or `mysqldump`.

## Test

`npm test` starts a throwaway PostgreSQL and checks listing, paging, insert, delete, drop and backup.

## Safety

- Table and column names are always quoted, values are always parameters.
- Row delete works only on tables with a primary key and rolls back if it would touch more than one row.
- The renderer has no Node access; it talks to the main process through a small preload API.
