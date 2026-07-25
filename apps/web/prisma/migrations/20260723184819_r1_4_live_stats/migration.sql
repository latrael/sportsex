-- CreateTable
CREATE TABLE "player_fixture_stat" (
    "id" SERIAL NOT NULL,
    "playerSeasonId" INTEGER NOT NULL,
    "fixtureId" INTEGER NOT NULL,
    "gameweekId" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
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

    CONSTRAINT "player_fixture_stat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_gameweek_stat" (
    "id" SERIAL NOT NULL,
    "playerSeasonId" INTEGER NOT NULL,
    "gameweekId" INTEGER NOT NULL,
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
    "bps" INTEGER NOT NULL,
    "tackles" INTEGER NOT NULL,
    "recoveries" INTEGER NOT NULL,
    "clearancesBlocksInterceptions" INTEGER NOT NULL,
    "defensiveContribution" INTEGER NOT NULL,
    "influence" DECIMAL(10,2) NOT NULL,
    "creativity" DECIMAL(10,2) NOT NULL,
    "threat" DECIMAL(10,2) NOT NULL,
    "ictIndex" DECIMAL(10,2) NOT NULL,
    "expectedGoals" DECIMAL(8,2) NOT NULL,
    "expectedAssists" DECIMAL(8,2) NOT NULL,
    "expectedGoalInvolvements" DECIMAL(8,2) NOT NULL,
    "expectedGoalsConceded" DECIMAL(8,2) NOT NULL,
    "totalPoints" INTEGER NOT NULL,

    CONSTRAINT "player_gameweek_stat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_payload" (
    "id" SERIAL NOT NULL,
    "endpoint" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "body" JSONB NOT NULL,

    CONSTRAINT "raw_payload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "player_fixture_stat_fixtureId_idx" ON "player_fixture_stat"("fixtureId");

-- CreateIndex
CREATE INDEX "player_fixture_stat_gameweekId_idx" ON "player_fixture_stat"("gameweekId");

-- CreateIndex
CREATE UNIQUE INDEX "player_fixture_stat_playerSeasonId_fixtureId_key" ON "player_fixture_stat"("playerSeasonId", "fixtureId");

-- CreateIndex
CREATE INDEX "player_gameweek_stat_gameweekId_idx" ON "player_gameweek_stat"("gameweekId");

-- CreateIndex
CREATE UNIQUE INDEX "player_gameweek_stat_playerSeasonId_gameweekId_key" ON "player_gameweek_stat"("playerSeasonId", "gameweekId");

-- CreateIndex
CREATE UNIQUE INDEX "raw_payload_endpoint_scopeKey_key" ON "raw_payload"("endpoint", "scopeKey");

-- AddForeignKey
ALTER TABLE "player_fixture_stat" ADD CONSTRAINT "player_fixture_stat_playerSeasonId_fkey" FOREIGN KEY ("playerSeasonId") REFERENCES "player_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_fixture_stat" ADD CONSTRAINT "player_fixture_stat_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_fixture_stat" ADD CONSTRAINT "player_fixture_stat_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "gameweek"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_gameweek_stat" ADD CONSTRAINT "player_gameweek_stat_playerSeasonId_fkey" FOREIGN KEY ("playerSeasonId") REFERENCES "player_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_gameweek_stat" ADD CONSTRAINT "player_gameweek_stat_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "gameweek"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

