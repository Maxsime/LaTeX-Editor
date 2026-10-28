CREATE TYPE "public"."template_visibility" AS ENUM('private', 'instance');--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"visibility" "template_visibility" DEFAULT 'private' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"manifest" jsonb NOT NULL,
	"folders" text[] DEFAULT '{}'::text[] NOT NULL,
	"main_path" text,
	"engine" "engine" DEFAULT 'pdflatex' NOT NULL,
	"bib_tool" "bib_tool" DEFAULT 'biber' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "link" jsonb;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "link_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_owner_idx" ON "templates" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "templates_instance_idx" ON "templates" USING btree ("visibility") WHERE "templates"."visibility" = 'instance';--> statement-breakpoint
CREATE UNIQUE INDEX "projects_texmf_owner_idx" ON "projects" USING btree ("owner_id") WHERE "projects"."type" = 'texmf';