CREATE TABLE IF NOT EXISTS acetate_reels (
    code text PRIMARY KEY,
    recording text NOT NULL,
    donation text NOT NULL,
    calibration bool NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS signal_excerpts (
    code text PRIMARY KEY,
    reel text NOT NULL REFERENCES acetate_reels(code),
    start_second integer NOT NULL CHECK(start_second >= 0),
    dropout integer NOT NULL CHECK(dropout BETWEEN 0 AND 30),
    snaps integer NOT NULL CHECK(snaps BETWEEN 0 AND 20),
    residue integer NOT NULL CHECK(residue BETWEEN 0 AND 9),
    known_route text CHECK(known_route IN ('clean','mend','rehouse')),
    UNIQUE(reel,start_second)
);
CREATE TABLE IF NOT EXISTS evaluation_manifests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label text UNIQUE NOT NULL,
    job bigint REFERENCES app_jobs(id),
    report jsonb,
    sealed_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz
);
CREATE TABLE IF NOT EXISTS holdout_assignments (
    evaluation bigint REFERENCES evaluation_manifests(id),
    excerpt text REFERENCES signal_excerpts(code),
    fold smallint NOT NULL CHECK(fold BETWEEN 1 AND 3),
    dropout integer,
    snaps integer,
    residue integer,
    known_route text CHECK(known_route IN ('clean','mend','rehouse')),
    PRIMARY KEY(evaluation,excerpt)
);
CREATE TABLE IF NOT EXISTS conservation_cards (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    excerpt text UNIQUE NOT NULL REFERENCES signal_excerpts(code),
    evaluation bigint NOT NULL REFERENCES evaluation_manifests(id),
    route text CHECK(route IN ('clean','mend','rehouse')),
    stage text NOT NULL DEFAULT 'proposed' CHECK(stage IN ('proposed','authorised','returned')),
    explanation text NOT NULL,
    authoriser text,
    returned_reason text
);
-- 附加迁移：既有表补齐封存时间、启用时间与送审快照列
ALTER TABLE evaluation_manifests ADD COLUMN IF NOT EXISTS sealed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE evaluation_manifests ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE holdout_assignments ADD COLUMN IF NOT EXISTS dropout integer;
ALTER TABLE holdout_assignments ADD COLUMN IF NOT EXISTS snaps integer;
ALTER TABLE holdout_assignments ADD COLUMN IF NOT EXISTS residue integer;
ALTER TABLE holdout_assignments ADD COLUMN IF NOT EXISTS known_route text;
ALTER TABLE conservation_cards ADD COLUMN IF NOT EXISTS returned_reason text;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='conservation_cards_stage_check' AND pg_get_constraintdef(oid) LIKE '%returned%'
    ) THEN
        ALTER TABLE conservation_cards DROP CONSTRAINT IF EXISTS conservation_cards_stage_check;
        ALTER TABLE conservation_cards ADD CONSTRAINT conservation_cards_stage_check
            CHECK(stage IN ('proposed','authorised','returned'));
    END IF;
END $$;
-- 既有清单行补回送审时的病征与签认工序
UPDATE holdout_assignments SET
    dropout=signal_excerpts.dropout,
    snaps=signal_excerpts.snaps,
    residue=signal_excerpts.residue,
    known_route=signal_excerpts.known_route
FROM signal_excerpts
WHERE signal_excerpts.code=holdout_assignments.excerpt AND holdout_assignments.dropout IS NULL;
-- 既有最新达标报告视为生效版
UPDATE evaluation_manifests SET activated_at=now()
WHERE id=(
    SELECT id FROM evaluation_manifests
    WHERE report IS NOT NULL AND (report->'accuracy'->>(report->>'selected'))::float >= 0.6
    ORDER BY id DESC LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM evaluation_manifests WHERE activated_at IS NOT NULL);
-- 生效版之外的待审工序卡退回
UPDATE conservation_cards SET stage='returned',
    returned_reason='复验生效版更新，原依据版本失效，请重算建议后再签发'
WHERE stage='proposed'
  AND evaluation <> (SELECT max(id) FROM evaluation_manifests WHERE activated_at IS NOT NULL);
