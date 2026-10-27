CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai', 'mistral', 'openai-compatible');--> statement-breakpoint
CREATE TABLE "ai_model_prices" (
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"input_per_mtok" double precision NOT NULL,
	"output_per_mtok" double precision NOT NULL,
	"cached_input_per_mtok" double precision,
	"currency" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_prices_provider_model_pk" PRIMARY KEY("provider","model")
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"key_ciphertext" "bytea",
	"key_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_input_tokens" integer NOT NULL,
	"cost_micros" bigint,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");