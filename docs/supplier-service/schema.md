# Supplier Service — Database Choice and Schema

D2 §1–§2. Backlog refs: SS-FR4.1.1, and the SUP-01 acceptance criteria.
Ticket: SUP-01 (#125); the catalogue listing is SUP-02 (#126). Out of scope
here: the listing UI (SUP-03) and the deletion-hold against live errands (SUP-04).

## 1. Database: PostgreSQL

**Why, for FoC specifically**

- **The data is structured and relational with a few optional fields.** A supplier
  is a fixed record — name, type, building, floor, location, coordinates, hours —
  queried by id and (in SUP-02) filtered by type/building/text. That is exactly
  what a typed table with indexes is for.
- **The invariants are database invariants.** The closed `type` enum, the
  required (`NOT NULL`) fields, coordinate ranges, and above all the
  case-insensitive "one active supplier per name+building" rule are enforced by a
  `CHECK`, `NOT NULL`, and a partial `UNIQUE` index — so a bad row cannot slip in
  through a race or a future code path, not only through the validator.
- **The optional, semi-structured bits fit JSONB.** Opening hours and tags vary in
  length and shape; storing them as `jsonb` columns on the same row keeps one
  supplier one row, with no join and no second store to keep consistent.
- **The write rules need transactions.** An idempotent create (insert the supplier
  and remember its Idempotency-Key together) and an optimistic update (bump the
  version only if it still matches) are single-database ACID operations: they
  commit fully or not at all.
- **Scale is small and the queries are B-tree hits.** One campus of suppliers —
  dozens, not millions — looked up by id or filtered by type/building. No
  sharding, no document flexibility, no search engine needed yet.
- **Team consistency.** Every FoC service already runs on one Postgres engine with
  a database and role per service (plan §3.1); reusing it means one skill set and
  one Compose service.

**Considered and rejected:** a document store (MongoDB) — buys nothing here: the
model is fixed and the cross-row uniqueness rule is *harder* without a unique
index, while the only semi-structured fields (hours, tags) are already handled by
JSONB columns. A search engine (Elasticsearch) — premature; text search is SUP-02
and Postgres covers it at this scale.

## 2. Schema

Forward-only Drizzle migrations (`drizzle/`). All ids are UUID; all timestamps
are `timestamptz` (UTC).

### `suppliers`

| Column                 | Type                            | Notes                                                                                    |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `supplier_id`          | uuid PK                         | Stable. Admin creates get a random UUID; seeded rows get a deterministic UUIDv5 (below). |
| `name`                 | text NOT NULL                   | 1–200 chars.                                                                             |
| `type`                 | text NOT NULL                   | `CHECK IN ('FOOD','CAFE','PRINTING','SHOPPING','LANDMARK')` — the closed enum.           |
| `building`             | text NOT NULL                   | Normalized to one canonical spelling per building (below).                                |
| `floor`                | text NOT NULL                   | Text, not int: `1`, `B1`, `G` are all valid.                                             |
| `location_description` | text NOT NULL                   | 1–500 chars.                                                                             |
| `opening_hours`        | jsonb NULL                      | `[{ day, opens, closes }]`; see §3.                                                       |
| `latitude`             | double precision NULL           | Paired with `longitude`; range-checked.                                                   |
| `longitude`            | double precision NULL           | Paired with `latitude`; range-checked.                                                    |
| `image_url`            | text NULL                       | Missing for ~15 of the 21 template rows, so optional.                                     |
| `tags`                 | jsonb NULL                      | Array of strings; the array shape is database checked.                                   |
| `active`               | boolean NOT NULL DEFAULT true   | Soft-deactivation flag. A deactivated supplier leaves listings but stays resolvable by id. |
| `version`              | integer NOT NULL DEFAULT 1      | Optimistic-lock counter; every update bumps it.                                           |
| `created_at`, `updated_at` | timestamptz NOT NULL        | `updated_at` bumped on every mutation.                                                    |

**Constraints**

- `suppliers_coordinates_paired` — `(latitude IS NULL) = (longitude IS NULL)`: a
  coordinate travels as a pair or not at all.
- `suppliers_latitude_range` / `suppliers_longitude_range` — a malformed
  coordinate is refused by the database as well as the API.
- `suppliers_name_building_active_key` — `UNIQUE (lower(name), lower(building)) WHERE active`:
  the case-insensitive name+building duplicate rule, scoped to active rows.
  "Starbucks @ YIH" and "Starbucks @ UTown" both live (different buildings); two
  active same-name suppliers in one building are refused; deactivating a supplier
  frees its name for reuse.

**Listing (SUP-02)**

At the current catalogue size, listing scans the active rows. The partial type
index from `0000_init` remains available for filtering; `0001_supplier_tags_array`
adds the database check that `tags` is a JSON array. A listing uses one SQL
statement for its count and page, so both come from the same snapshot. Only the
selected sort key follows `order`; ties sort by name, building, then supplier ID
ascending. Search checks name, building,
location description, and each tag value separately.

### `supplier_idempotency_keys`

| Column            | Type        | Notes                                                          |
| ----------------- | ----------- | -------------------------------------------------------------- |
| `idempotency_key` | text PK     | The client's `Idempotency-Key` header on a create.            |
| `supplier_id`     | uuid FK → suppliers ON DELETE CASCADE | The supplier that key produced.      |
| `created_at`      | timestamptz | |

A create that carries an `Idempotency-Key` takes a transaction-scoped advisory
lock on the key, then either returns the supplier already mapped to it (a replay)
or inserts the supplier and claims the key — so a retry returns the original
supplier instead of a second row or a 409.

## 3. Opening-hours representation (decision)

Stored as a JSONB array of per-day windows:

```json
[{ "day": "MON", "opens": "09:00", "closes": "18:00" }, ...]
```

- `day` ∈ `MON…SUN`; `opens`/`closes` are 24-hour `HH:MM`.
- The source gives one start/close pair per supplier, so the seed applies it to
  all seven days. A real per-day schedule is representable without a migration.
- **Open all day** (`0000hrs`–`2359hrs`) is stored as `00:00`–`23:59`.
- **Past-midnight** closes (e.g. `1100hrs`–`0200hrs`) are stored verbatim; a
  `closes` at or before `opens` means the window runs into the next day. This
  keeps one row per day and avoids inventing a synthetic `24:00`.

Chosen over a fixed 7×2 column layout (rigid, mostly-null) and over a separate
`opening_hours` table (a join and a second write for data that is always read with
its supplier and never queried on its own at this stage).

## 4. Seeding

`src/admin/seed.ts` loads the catalogue at boot. It is **idempotent and stable**:
each supplier's `supplier_id` is a UUIDv5 derived from `lower(name)|building`, so a
row inserted once is skipped (`ON CONFLICT (supplier_id) DO NOTHING`) on every
later run. Three runs produce the same rows and ids; an admin's later edits or
deactivations are never overwritten. Each insert is its own transaction, so one
skipped row cannot roll back the rest.

Normalization (`src/admin/normalize.ts`) maps the messy source onto the schema:

- **Types:** `Food`→`FOOD`, `Food/Coffee`→`CAFE`, `Printing`→`PRINTING`,
  `Shopping`→`SHOPPING`, `Landmark`→`LANDMARK`.
- **Buildings:** `Com 2`/`Com2`→`COM2`; the ASCII, Windows-1252 (`\x92`) and
  Unicode apostrophes in "Prince George's Park" collapse to one spelling; a handful
  of others (`innovation4.0`→`Innovation 4.0`, `Blk AS8`→`Block AS8`) are tidied —
  so the building filter shows each building once and the duplicate rule catches
  real duplicates.
- **Hours:** `0900hrs`→`09:00`, with the all-day and past-midnight handling in §3.

The template CSV has 21 rows; `data/csv/supplier-seed-additions.csv` adds 12 more
(including the LANDMARK pickup points the template lacks), taking the corpus to 33
active suppliers across 20 buildings and all five types — past SS-FR4.1.1's floor
of ≥30 across ≥10 buildings and every type.

## 5. Traceability

| Requirement / acceptance                                            | Where it lives                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Required vs optional enforced by the DB                             | `NOT NULL` columns; nullable optionals                           |
| Closed `type` enum                                                  | `CHECK (type IN …)`                                              |
| Case-insensitive name+building duplicate, active only               | `suppliers_name_building_active_key`                             |
| Every invalid field returned at once as 422 `VALIDATION_FAILED`     | `src/suppliers/validation.ts` (`parseOrThrow`)                   |
| Admin-only create/update/deactivate; non-admin → 403                | `@AdminOnly()` (`@foc/auth-client`), read server-side            |
| Soft deactivation, excluded from lists, resolvable by id            | `active` flag; `list` vs `findById`                              |
| Idempotency-Key replay returns the original, not 409                | `supplier_idempotency_keys` + advisory lock                     |
| Stale `If-Match` → 412, nothing changed                             | `version` column; conditional `UPDATE … WHERE version = $`       |
| One row per write, all-or-nothing                                   | every mutation wrapped in `db.transaction`                       |
| Idempotent, stable seed (same count and ids over three runs)        | UUIDv5 ids + `ON CONFLICT DO NOTHING`                           |
| ≥30 active records, ≥10 buildings, all types                        | template CSV + `supplier-seed-additions.csv`                    |
