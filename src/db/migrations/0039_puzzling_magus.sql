CREATE TABLE "audio_pipeline_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"generation" integer NOT NULL,
	"provider_id" text,
	"provider" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"language" varchar(10),
	"trigger" varchar(16) NOT NULL,
	"duration_ms" bigint NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"phase" varchar(24) DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"pipeline_job_id" text,
	"config_snapshot" jsonb NOT NULL,
	"timestamp_source" varchar(10),
	"error_type" varchar(80),
	"error_message" text,
	"lease_token" text,
	"lease_until" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "timeline" jsonb;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "timeline_source" varchar(10);--> statement-breakpoint
ALTER TABLE "audio_pipeline_jobs" ADD CONSTRAINT "audio_pipeline_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_pipeline_jobs" ADD CONSTRAINT "audio_pipeline_jobs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_pipeline_jobs_recording_generation_unique" ON "audio_pipeline_jobs" USING btree ("recording_id","user_id","generation");--> statement-breakpoint
CREATE INDEX "audio_pipeline_jobs_pending_idx" ON "audio_pipeline_jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_pipeline_jobs_active_recording_unique" ON "audio_pipeline_jobs" USING btree ("recording_id","user_id") WHERE "audio_pipeline_jobs"."status" IN ('queued', 'submitted', 'running', 'paused');