-- FPL serves club strength ratings as null all through preseason (found when the
-- API rolled 25/26 → 26/27 on 2026-07-23). Make the columns nullable so a
-- current-season bootstrap parses and stores null rather than failing.
ALTER TABLE "club_season" ALTER COLUMN "strength" DROP NOT NULL,
                          ALTER COLUMN "strengthOverallHome" DROP NOT NULL,
                          ALTER COLUMN "strengthOverallAway" DROP NOT NULL,
                          ALTER COLUMN "strengthAttackHome" DROP NOT NULL,
                          ALTER COLUMN "strengthAttackAway" DROP NOT NULL,
                          ALTER COLUMN "strengthDefenceHome" DROP NOT NULL,
                          ALTER COLUMN "strengthDefenceAway" DROP NOT NULL;
