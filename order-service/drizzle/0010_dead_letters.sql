-- Custom migration (PLT-05): the dead letters an operator finds, reads and redrives. The DDL is
-- @foc/platform's DEAD_LETTERS_TABLE_SQL as of this migration; a row changes once, to record a
-- redrive, and is never deleted.
CREATE TABLE IF NOT EXISTS dead_letters (
  id                     uuid PRIMARY KEY,
  queue                  text NOT NULL,
  event_id               text,
  event_type             text,
  aggregate_id           text,
  correlation_id         text,
  failure_reason         text,
  attempts               integer NOT NULL,
  body                   bytea NOT NULL,
  properties             jsonb NOT NULL,
  parked_at              timestamptz NOT NULL DEFAULT now(),
  redriven_at            timestamptz,
  redriven_by            text,
  redrive_reason         text,
  redrive_correlation_id text,
  CONSTRAINT dead_letters_redrive_complete CHECK (
    (redriven_at IS NULL) = (redriven_by IS NULL)
    AND (redriven_at IS NULL) = (redrive_reason IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dead_letters_waiting_idx ON dead_letters (parked_at DESC) WHERE redriven_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dead_letters_correlation_idx ON dead_letters (correlation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dead_letters_aggregate_idx ON dead_letters (aggregate_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dead_letters_event_idx ON dead_letters (event_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dead_letters_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dead_letters is kept: a row is never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.redriven_at IS NOT NULL
     OR (NEW.id, NEW.queue, NEW.event_id, NEW.event_type, NEW.aggregate_id, NEW.correlation_id,
         NEW.failure_reason, NEW.attempts, NEW.body, NEW.properties, NEW.parked_at)
        IS DISTINCT FROM
        (OLD.id, OLD.queue, OLD.event_id, OLD.event_type, OLD.aggregate_id, OLD.correlation_id,
         OLD.failure_reason, OLD.attempts, OLD.body, OLD.properties, OLD.parked_at) THEN
    RAISE EXCEPTION 'dead_letters rows change once, to record a redrive' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dead_letters_guard ON dead_letters;
--> statement-breakpoint
CREATE TRIGGER dead_letters_guard BEFORE UPDATE OR DELETE ON dead_letters
  FOR EACH ROW EXECUTE FUNCTION dead_letters_guard();
