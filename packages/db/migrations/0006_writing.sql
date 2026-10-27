CREATE TABLE "user_dictionary_words" (
	"user_id" uuid NOT NULL,
	"word" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_dictionary_words_user_id_word_pk" PRIMARY KEY("user_id","word")
);
--> statement-breakpoint
CREATE TABLE "zotero_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"zotero_user_id" text NOT NULL,
	"username" text NOT NULL,
	"api_key_ciphertext" "bytea" NOT NULL,
	"key_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cite_key_pattern" text DEFAULT '[auth:lower][year][shorttitle:lower]' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "spell_language" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "chktex_disabled" integer[] DEFAULT '{1,8,13,36,44}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_dictionary_words" ADD CONSTRAINT "user_dictionary_words_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zotero_accounts" ADD CONSTRAINT "zotero_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;