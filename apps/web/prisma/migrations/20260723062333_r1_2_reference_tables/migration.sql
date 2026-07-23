-- CreateEnum
CREATE TYPE "Position" AS ENUM ('GKP', 'DEF', 'MID', 'FWD');

-- CreateTable
CREATE TABLE "season" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "startYear" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club" (
    "id" SERIAL NOT NULL,
    "fplCode" INTEGER NOT NULL,
    "pulseId" INTEGER,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,

    CONSTRAINT "club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_season" (
    "id" SERIAL NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "clubId" INTEGER NOT NULL,
    "fplId" INTEGER NOT NULL,
    "strength" INTEGER NOT NULL,
    "strengthOverallHome" INTEGER NOT NULL,
    "strengthOverallAway" INTEGER NOT NULL,
    "strengthAttackHome" INTEGER NOT NULL,
    "strengthAttackAway" INTEGER NOT NULL,
    "strengthDefenceHome" INTEGER NOT NULL,
    "strengthDefenceAway" INTEGER NOT NULL,

    CONSTRAINT "club_season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fpl_player" (
    "id" SERIAL NOT NULL,
    "fplCode" INTEGER NOT NULL,
    "optaCode" TEXT,
    "firstName" TEXT NOT NULL,
    "secondName" TEXT NOT NULL,
    "webName" TEXT NOT NULL,
    "birthDate" DATE,

    CONSTRAINT "fpl_player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_season" (
    "id" SERIAL NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "clubSeasonId" INTEGER NOT NULL,
    "fplId" INTEGER NOT NULL,
    "position" "Position" NOT NULL,
    "status" TEXT NOT NULL,
    "chanceOfPlayingThisRound" INTEGER,
    "chanceOfPlayingNextRound" INTEGER,
    "news" TEXT NOT NULL,
    "newsAddedAt" TIMESTAMP(3),
    "squadNumber" INTEGER,
    "teamJoinDate" DATE,
    "nowCost" INTEGER NOT NULL,
    "selectedByPercent" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "player_season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gameweek" (
    "id" SERIAL NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "deadlineTime" TIMESTAMP(3),
    "finished" BOOLEAN NOT NULL,
    "dataChecked" BOOLEAN NOT NULL,
    "isPrevious" BOOLEAN NOT NULL,
    "isCurrent" BOOLEAN NOT NULL,
    "isNext" BOOLEAN NOT NULL,
    "averageEntryScore" INTEGER,
    "highestScore" INTEGER,

    CONSTRAINT "gameweek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "season_name_key" ON "season"("name");

-- CreateIndex
CREATE UNIQUE INDEX "season_startYear_key" ON "season"("startYear");

-- CreateIndex
CREATE UNIQUE INDEX "club_fplCode_key" ON "club"("fplCode");

-- CreateIndex
CREATE UNIQUE INDEX "club_season_seasonId_clubId_key" ON "club_season"("seasonId", "clubId");

-- CreateIndex
CREATE UNIQUE INDEX "club_season_seasonId_fplId_key" ON "club_season"("seasonId", "fplId");

-- CreateIndex
CREATE UNIQUE INDEX "fpl_player_fplCode_key" ON "fpl_player"("fplCode");

-- CreateIndex
CREATE UNIQUE INDEX "fpl_player_optaCode_key" ON "fpl_player"("optaCode");

-- CreateIndex
CREATE INDEX "player_season_clubSeasonId_idx" ON "player_season"("clubSeasonId");

-- CreateIndex
CREATE UNIQUE INDEX "player_season_seasonId_playerId_key" ON "player_season"("seasonId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "player_season_seasonId_fplId_key" ON "player_season"("seasonId", "fplId");

-- CreateIndex
CREATE UNIQUE INDEX "gameweek_seasonId_number_key" ON "gameweek"("seasonId", "number");

-- AddForeignKey
ALTER TABLE "club_season" ADD CONSTRAINT "club_season_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_season" ADD CONSTRAINT "club_season_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season" ADD CONSTRAINT "player_season_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season" ADD CONSTRAINT "player_season_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "fpl_player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_season" ADD CONSTRAINT "player_season_clubSeasonId_fkey" FOREIGN KEY ("clubSeasonId") REFERENCES "club_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gameweek" ADD CONSTRAINT "gameweek_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
