CREATE TABLE "project_remotes" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"branch" text NOT NULL,
	"token_ciphertext" "bytea" NOT NULL,
	"token_hint" text NOT NULL,
	"last_commit" text,
	"last_synced_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_remotes" ADD CONSTRAINT "project_remotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_remotes" ADD CONSTRAINT "project_remotes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;