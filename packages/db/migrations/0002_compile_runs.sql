CREATE TYPE "public"."compile_status" AS ENUM('queued', 'running', 'success', 'failure', 'timeout', 'cancelled', 'superseded', 'error');--> statement-breakpoint
CREATE TABLE "compile_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"status" "compile_status" DEFAULT 'queued' NOT NULL,
	"engine" "engine" NOT NULL,
	"main_file" text NOT NULL,
	"options" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"result" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compile_runs" ADD CONSTRAINT "compile_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_runs" ADD CONSTRAINT "compile_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compile_runs_project_idx" ON "compile_runs" USING btree ("project_id","created_at");