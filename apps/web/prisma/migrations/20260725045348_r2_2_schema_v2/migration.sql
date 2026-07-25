-- R2.2 — schema v2 derived + market tables (TODO_2627.md).
-- Adds player_season_stat, fair_value, asset, price_tick, trade, position and
-- ledger_entry, and renames the Position enum to PlayerPosition.

-- Rename the Position enum to PlayerPosition (R2.1). Prisma models an enum
-- rename as drop-column + recreate-NOT-NULL, which discards
-- player_season.position and fails on any populated table. An in-place
-- ALTER TYPE RENAME preserves the data, and the values are identical.
ALTER TYPE "Position" RENAME TO "PlayerPosition";

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('PLAYER', 'CLUB');

-- CreateEnum
CREATE TYPE "FairValueSource" AS ENUM ('GAMEWEEK', 'AVAILABILITY', 'SEED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PriceTickSource" AS ENUM ('TRADE', 'VALUATION');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('USER_CASH', 'AMM_LIQUIDITY', 'FEE_SINK', 'MINT');

-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('TRADE_BUY', 'TRADE_SELL', 'TRADE_FEE', 'COIN_GRANT', 'QUEST_REWARD', 'PREDICTION_STAKE', 'PREDICTION_PAYOUT');

-- CreateTable
CREATE TABLE "player_season_stat" (
    "id" SERIAL NOT NULL,
    "playerSeasonId" INTEGER NOT NULL,
    "appearances" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "starts" INTEGER NOT NULL,
    "goalsScored" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "cleanSheets" INTEGER NOT NULL,
    "goalsConceded" INTEGER NOT NULL,
    "ownGoals" INTEGER NOT NULL,
    "penaltiesSaved" INTEGER NOT NULL,
    "penaltiesMissed" INTEGER NOT NULL,
    "yellowCards" INTEGER NOT NULL,
    "redCards" INTEGER NOT NULL,
    "saves" INTEGER NOT NULL,
    "bonus" INTEGER NOT NULL,
    "defensiveContribution" INTEGER NOT NULL,
    "totalPoints" INTEGER NOT NULL,
    "bps" INTEGER NOT NULL,
    "tackles" INTEGER NOT NULL,
    "recoveries" INTEGER NOT NULL,
    "clearancesBlocksInterceptions" INTEGER NOT NULL,
    "influence" DECIMAL(10,2) NOT NULL,
    "creativity" DECIMAL(10,2) NOT NULL,
    "threat" DECIMAL(10,2) NOT NULL,
    "ictIndex" DECIMAL(10,2) NOT NULL,
    "expectedGoals" DECIMAL(10,2) NOT NULL,
    "expectedAssists" DECIMAL(10,2) NOT NULL,
    "expectedGoalInvolvements" DECIMAL(10,2) NOT NULL,
    "expectedGoalsConceded" DECIMAL(10,2) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_season_stat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" SERIAL NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "playerSeasonId" INTEGER,
    "clubSeasonId" INTEGER,
    "inventory" INTEGER NOT NULL DEFAULT 0,
    "seedInventory" INTEGER NOT NULL DEFAULT 0,
    "liquidity" DECIMAL(18,6) NOT NULL DEFAULT 1,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fair_value" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "gameweekId" INTEGER,
    "source" "FairValueSource" NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "baseline" DECIMAL(12,6),
    "form" DECIMAL(12,6),
    "availabilityMult" DECIMAL(6,4),
    "positionBase" DECIMAL(12,4),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fair_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "side" "TradeSide" NOT NULL,
    "shares" INTEGER NOT NULL,
    "avgPrice" DECIMAL(12,4) NOT NULL,
    "grossCost" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "inventoryAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tick" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "source" "PriceTickSource" NOT NULL,
    "tradeId" INTEGER,
    "price" DECIMAL(12,4) NOT NULL,
    "fairValue" DECIMAL(12,4) NOT NULL,
    "inventory" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_tick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "shares" INTEGER NOT NULL,
    "avgCost" DECIMAL(12,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "account" "LedgerAccount" NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "amount" BIGINT NOT NULL,
    "transferId" TEXT NOT NULL,
    "tradeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "player_season_stat_playerSeasonId_key" ON "player_season_stat"("playerSeasonId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_playerSeasonId_key" ON "asset"("playerSeasonId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_clubSeasonId_key" ON "asset"("clubSeasonId");

-- CreateIndex
CREATE INDEX "asset_kind_idx" ON "asset"("kind");

-- CreateIndex
CREATE INDEX "fair_value_assetId_computedAt_idx" ON "fair_value"("assetId", "computedAt");

-- CreateIndex
CREATE INDEX "fair_value_gameweekId_idx" ON "fair_value"("gameweekId");

-- CreateIndex
CREATE INDEX "trade_userId_createdAt_idx" ON "trade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "trade_assetId_createdAt_idx" ON "trade"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "price_tick_tradeId_key" ON "price_tick"("tradeId");

-- CreateIndex
CREATE INDEX "price_tick_assetId_computedAt_idx" ON "price_tick"("assetId", "computedAt");

-- CreateIndex
CREATE INDEX "position_assetId_idx" ON "position"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "position_userId_assetId_key" ON "position"("userId", "assetId");

-- CreateIndex
CREATE INDEX "ledger_entry_userId_createdAt_idx" ON "ledger_entry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entry_transferId_idx" ON "ledger_entry"("transferId");

-- CreateIndex
CREATE INDEX "ledger_entry_account_createdAt_idx" ON "ledger_entry"("account", "createdAt");

-- AddForeignKey
ALTER TABLE "player_season_stat" ADD CONSTRAINT "player_season_stat_playerSeasonId_fkey" FOREIGN KEY ("playerSeasonId") REFERENCES "player_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_playerSeasonId_fkey" FOREIGN KEY ("playerSeasonId") REFERENCES "player_season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_clubSeasonId_fkey" FOREIGN KEY ("clubSeasonId") REFERENCES "club_season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Asset exclusive arc: exactly one of playerSeasonId / clubSeasonId is set.
-- Prisma can't express this, so it's added by hand (R2.1's note). This is what
-- makes the player/club split real referential integrity rather than the v1
-- polymorphic assetKind/assetId pair.
ALTER TABLE "asset" ADD CONSTRAINT "asset_exactly_one_subject"
  CHECK (("playerSeasonId" IS NOT NULL) <> ("clubSeasonId" IS NOT NULL));

-- AddForeignKey
ALTER TABLE "fair_value" ADD CONSTRAINT "fair_value_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fair_value" ADD CONSTRAINT "fair_value_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "gameweek"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tick" ADD CONSTRAINT "price_tick_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tick" ADD CONSTRAINT "price_tick_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
