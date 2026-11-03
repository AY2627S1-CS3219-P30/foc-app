CREATE TABLE "channels" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"latest_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"sender_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_order_id_seq_pk" PRIMARY KEY("order_id","seq"),
	CONSTRAINT "messages_sender_client_key" UNIQUE("order_id","sender_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "read_positions" (
	"order_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "read_positions_order_id_user_id_pk" PRIMARY KEY("order_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_channels_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."channels"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_order_id_channels_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."channels"("order_id") ON DELETE cascade ON UPDATE no action;