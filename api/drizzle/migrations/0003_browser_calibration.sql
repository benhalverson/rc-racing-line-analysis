-- Existing analyses were created with a server-side video_path and have no
-- browser reference. Keep those records addressable through their original
-- path instead of relabeling them as browser-local videos.
ALTER TABLE analyses ADD COLUMN video_storage text NOT NULL DEFAULT 'browser-sqlite';
ALTER TABLE analyses ADD COLUMN local_video_ref text NOT NULL DEFAULT '{}';
UPDATE analyses SET video_storage = 'legacy', local_video_ref = '{}';
ALTER TABLE analyses ADD COLUMN accepted_correction_set_id text;
CREATE TABLE IF NOT EXISTS correction_sets (
  id text PRIMARY KEY NOT NULL,
  analysis_id text NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  version integer NOT NULL,
  payload text NOT NULL,
  accepted integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);
