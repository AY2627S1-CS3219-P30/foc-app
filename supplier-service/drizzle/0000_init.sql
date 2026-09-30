CREATE TABLE "supplier_idempotency_keys" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"supplier_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"building" text NOT NULL,
	"floor" text NOT NULL,
	"location_description" text NOT NULL,
	"opening_hours" jsonb,
	"latitude" double precision,
	"longitude" double precision,
	"image_url" text,
	"tags" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_name_len" CHECK (char_length("suppliers"."name") BETWEEN 1 AND 200),
	CONSTRAINT "suppliers_type_enum" CHECK ("suppliers"."type" IN ('FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK')),
	CONSTRAINT "suppliers_building_len" CHECK (char_length("suppliers"."building") BETWEEN 1 AND 200),
	CONSTRAINT "suppliers_floor_len" CHECK (char_length("suppliers"."floor") BETWEEN 1 AND 50),
	CONSTRAINT "suppliers_location_len" CHECK (char_length("suppliers"."location_description") BETWEEN 1 AND 500),
	CONSTRAINT "suppliers_image_url_len" CHECK ("suppliers"."image_url" IS NULL OR char_length("suppliers"."image_url") BETWEEN 1 AND 2048),
	CONSTRAINT "suppliers_version_positive" CHECK ("suppliers"."version" >= 1),
	CONSTRAINT "suppliers_coordinates_paired" CHECK (("suppliers"."latitude" IS NULL) = ("suppliers"."longitude" IS NULL)),
	CONSTRAINT "suppliers_latitude_range" CHECK ("suppliers"."latitude" IS NULL OR "suppliers"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "suppliers_longitude_range" CHECK ("suppliers"."longitude" IS NULL OR "suppliers"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "supplier_idempotency_keys" ADD CONSTRAINT "supplier_idempotency_keys_supplier_id_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("supplier_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_building_active_key" ON "suppliers" USING btree (lower("name"),lower("building")) WHERE active;--> statement-breakpoint
CREATE INDEX "suppliers_active_type_idx" ON "suppliers" USING btree ("type") WHERE active;