-- R5.7 — Drop the v1 engine-room tables (Team, Player, Match, PlayerMatchStat,
-- Valuation, Holding, Transaction, Order), rewire Comment and Prediction to the
-- v2 reference tables, and rename fpl_player -> player in-place so existing
-- backfilled player identities are preserved.

-- Clear any legacy v1 rows in Comment / Prediction that referenced v1 Player / Match
DELETE FROM "Prediction";
UPDATE "Comment" SET "playerId" = NULL;

-- DropForeignKey (v1 engine-room + Comment/Prediction v1 FKs)
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_playerId_fkey";
ALTER TABLE "Holding" DROP CONSTRAINT "Holding_userId_fkey";
ALTER TABLE "Match" DROP CONSTRAINT "Match_awayTeamId_fkey";
ALTER TABLE "Match" DROP CONSTRAINT "Match_homeTeamId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";
ALTER TABLE "Player" DROP CONSTRAINT "Player_teamId_fkey";
ALTER TABLE "PlayerMatchStat" DROP CONSTRAINT "PlayerMatchStat_matchId_fkey";
ALTER TABLE "PlayerMatchStat" DROP CONSTRAINT "PlayerMatchStat_playerId_fkey";
ALTER TABLE "Prediction" DROP CONSTRAINT "Prediction_matchId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_userId_fkey";
ALTER TABLE "Valuation" DROP CONSTRAINT "Valuation_matchId_fkey";
ALTER TABLE "Valuation" DROP CONSTRAINT "Valuation_playerId_fkey";
ALTER TABLE "Valuation" DROP CONSTRAINT "Valuation_teamId_fkey";

-- DropIndex
DROP INDEX "Comment_teamId_createdAt_idx";
DROP INDEX "Prediction_matchId_resolved_idx";

-- AlterTable Comment & Prediction & gameweek
ALTER TABLE "Comment" DROP COLUMN "teamId",
ADD COLUMN     "clubId" INTEGER;

ALTER TABLE "Prediction" DROP COLUMN "matchId",
ADD COLUMN     "fixtureId" INTEGER NOT NULL,
ADD COLUMN     "odds" DECIMAL(8,4) NOT NULL DEFAULT 2;

ALTER TABLE "gameweek" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- DropTable (all 8 v1 engine-room tables)
DROP TABLE "Holding";
DROP TABLE "Match";
DROP TABLE "Order";
DROP TABLE "Player";
DROP TABLE "PlayerMatchStat";
DROP TABLE "Team";
DROP TABLE "Transaction";
DROP TABLE "Valuation";

-- RenameTable fpl_player -> player in-place (preserving backfilled rows & PK sequence)
ALTER TABLE "fpl_player" RENAME TO "player";
ALTER TABLE "player" RENAME CONSTRAINT "fpl_player_pkey" TO "player_pkey";
ALTER INDEX "fpl_player_fplCode_key" RENAME TO "player_fplCode_key";
ALTER INDEX "fpl_player_optaCode_key" RENAME TO "player_optaCode_key";
ALTER SEQUENCE "fpl_player_id_seq" RENAME TO "player_id_seq";

-- CreateIndex
CREATE INDEX "Comment_clubId_createdAt_idx" ON "Comment"("clubId", "createdAt");
CREATE INDEX "Prediction_fixtureId_resolved_idx" ON "Prediction"("fixtureId", "resolved");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "club"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
