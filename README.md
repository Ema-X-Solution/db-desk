# db-desk

A desktop app (Electron + TypeScript) to browse and manage SQL databases on your server.
PostgreSQL first. MySQL and SQL Server can be added as new drivers (`src/main/db/types.ts`).

## Features

- Save connections (host, port, user, password, database, SSL). Passwords are encrypted with the OS keychain and stay on your computer.
- See all tables, their sizes, and the total database size.
- Browse table data with paging.
- Add a row, delete a row (by primary key), drop a table.
- Every delete asks for confirmation. Dropping a table requires typing the table name.
- Backup the whole database to a `.sql` file with `pg_dump`.

## Run

```
npm install
npm start
```

Backup needs the PostgreSQL client tools (`pg_dump`) on your PATH, version equal to or newer than your server.

## Test

`npm test` starts a throwaway PostgreSQL and checks listing, paging, insert, delete, drop and backup.

## Safety

- Table and column names are always quoted, values are always parameters.
- Row delete works only on tables with a primary key and rolls back if it would touch more than one row.
- The renderer has no Node access; it talks to the main process through a small preload API.
