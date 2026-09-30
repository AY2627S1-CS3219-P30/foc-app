import type { Migration } from '@foc/platform';

/**
 * Forward-only migrations, applied in order at boot and never edited once
 * merged: a change is a new entry. Kept as TypeScript strings rather than .sql
 * files so `tsc` carries them into `dist/` with no copy step.
 *
 * Schema rationale: docs/supplier-service/schema.md.
 */
export const migrations: Migration[] = [
  {
    id: '001_suppliers',
    sql: `
      CREATE TABLE suppliers (
        supplier_id          uuid PRIMARY KEY,
        name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
        -- A closed enum, enforced by the database so a bad type cannot slip in
        -- through a future code path, not only through the validator (SUP-01).
        type                 text NOT NULL
                             CHECK (type IN ('FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK')),
        building             text NOT NULL CHECK (char_length(building) BETWEEN 1 AND 200),
        floor                text NOT NULL CHECK (char_length(floor) BETWEEN 1 AND 50),
        location_description text NOT NULL CHECK (char_length(location_description) BETWEEN 1 AND 500),
        -- Optional. Per-day opening hours as [{ day, opens, closes }]; see the
        -- README for the representation and the post-midnight convention.
        opening_hours        jsonb,
        -- Coordinates travel as a pair or not at all. Ranges are checked here so
        -- a malformed coordinate is refused by the database as well as the API.
        latitude             double precision,
        longitude            double precision,
        image_url            text CHECK (image_url IS NULL OR char_length(image_url) BETWEEN 1 AND 2048),
        tags                 jsonb,
        active               boolean NOT NULL DEFAULT true,
        -- Optimistic-lock counter. Every update bumps it; a stale If-Match is
        -- refused with 412 so a lost update cannot overwrite a newer edit.
        version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT suppliers_coordinates_paired
          CHECK ((latitude IS NULL) = (longitude IS NULL)),
        CONSTRAINT suppliers_latitude_range
          CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
        CONSTRAINT suppliers_longitude_range
          CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
      );

      -- The case-insensitive "name + building" duplicate rule, scoped to active
      -- rows only. "Starbucks @ YIH" and "Starbucks @ UTown" both live (different
      -- buildings); two active same-name suppliers in one building are refused.
      -- A deactivated row leaves the name free to be reused.
      CREATE UNIQUE INDEX suppliers_name_building_active_key
        ON suppliers (lower(name), building)
        WHERE active;

      -- Listings only ever read active rows, filtered by type (SUP-02 builds on this).
      CREATE INDEX suppliers_active_type_idx ON suppliers (type) WHERE active;

      -- Retry safety (SUP-01): a create may carry an Idempotency-Key. The key is
      -- remembered here with the supplier it produced, so a replayed request
      -- returns the original supplier instead of creating a second one or 409ing.
      CREATE TABLE supplier_idempotency_keys (
        idempotency_key text PRIMARY KEY,
        supplier_id     uuid NOT NULL REFERENCES suppliers (supplier_id) ON DELETE CASCADE,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '002_building_ci_index_and_idempotency_hash',
    sql: `
      -- The building filter and the name+building duplicate rule must compare
      -- buildings case-insensitively. The API now canonicalizes building on the
      -- way in (matching the seed), but recreate the unique index on
      -- lower(building) as a backstop so two casings can never both go active.
      -- Reuse the same index name so the service's NAME_BUILDING_INDEX constant
      -- still matches the violated-constraint name. Keep the WHERE active scope.
      DROP INDEX suppliers_name_building_active_key;
      CREATE UNIQUE INDEX suppliers_name_building_active_key
        ON suppliers (lower(name), lower(building))
        WHERE active;

      -- Bind each Idempotency-Key to the body that first used it. A replay with
      -- the same body returns the original supplier; a reused key with a
      -- different body is rejected (422) instead of silently replaying. Existing
      -- rows predate the check; backfill with '' so the NOT NULL can be added.
      ALTER TABLE supplier_idempotency_keys ADD COLUMN request_hash text NOT NULL DEFAULT '';
      ALTER TABLE supplier_idempotency_keys ALTER COLUMN request_hash DROP DEFAULT;
    `,
  },
  {
    id: '003_supplier_search_indexes',
    sql: `
      -- Trigram matching backs the case-insensitive substring search (SUP-02).
      -- pg_trgm is a standard contrib extension; the test DB (PGlite) loads it too.
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      -- The sort paths, matching each ORDER BY exactly (a backward scan serves
      -- DESC). Text keys are lower-cased and every sort tie-breaks by lower(name)
      -- then supplier_id. The building index also serves the building filter,
      -- and the type index supersedes 001's (type) index.
      DROP INDEX suppliers_active_type_idx;
      CREATE INDEX suppliers_active_name_idx
        ON suppliers (lower(name), supplier_id) WHERE active;
      CREATE INDEX suppliers_active_type_name_idx
        ON suppliers (type, lower(name), supplier_id) WHERE active;
      CREATE INDEX suppliers_active_building_name_idx
        ON suppliers (lower(building), lower(name), supplier_id) WHERE active;
      CREATE INDEX suppliers_active_updated_idx
        ON suppliers (updated_at, lower(name), supplier_id) WHERE active;

      -- Tag values as one newline-joined string, so tag search matches values,
      -- never JSON syntax, and can use a trigram index like the other fields.
      CREATE FUNCTION supplier_tags_text(tags jsonb) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
        AS $$ SELECT string_agg(tag, E'\\n') FROM jsonb_array_elements_text(tags) AS tag $$;

      -- Every search arm is trigram-indexed, so the planner can BitmapOr them
      -- rather than scanning.
      CREATE INDEX suppliers_name_trgm_idx ON suppliers USING gin (name gin_trgm_ops) WHERE active;
      CREATE INDEX suppliers_building_trgm_idx ON suppliers USING gin (building gin_trgm_ops) WHERE active;
      CREATE INDEX suppliers_location_trgm_idx ON suppliers USING gin (location_description gin_trgm_ops) WHERE active;
      CREATE INDEX suppliers_tags_trgm_idx
        ON suppliers USING gin (supplier_tags_text(tags) gin_trgm_ops) WHERE active;
    `,
  },
];
