-- CreateTable
CREATE TABLE "fixture" (
    "id" SERIAL NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "gameweekId" INTEGER,
    "fplId" INTEGER NOT NULL,
    "code" INTEGER NOT NULL,
    "homeClubSeasonId" INTEGER NOT NULL,
    "awayClubSeasonId" INTEGER NOT NULL,
    "kickoffTime" TIMESTAMP(3),
    "started" BOOLEAN,
    "finished" BOOLEAN NOT NULL,
    "finishedProvisional" BOOLEAN NOT NULL,
    "provisionalStartTime" BOOLEAN NOT NULL,
    "minutes" INTEGER NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "homeDifficulty" INTEGER NOT NULL,
    "awayDifficulty" INTEGER NOT NULL,

    CONSTRAINT "fixture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fixture_code_key" ON "fixture"("code");

-- CreateIndex
CREATE INDEX "fixture_gameweekId_idx" ON "fixture"("gameweekId");

-- CreateIndex
CREATE INDEX "fixture_kickoffTime_idx" ON "fixture"("kickoffTime");

-- CreateIndex
CREATE INDEX "fixture_homeClubSeasonId_idx" ON "fixture"("homeClubSeasonId");

-- CreateIndex
CREATE INDEX "fixture_awayClubSeasonId_idx" ON "fixture"("awayClubSeasonId");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_seasonId_fplId_key" ON "fixture"("seasonId", "fplId");

-- AddForeignKey
ALTER TABLE "fixture" ADD CONSTRAINT "fixture_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture" ADD CONSTRAINT "fixture_gameweekId_fkey" FOREIGN KEY ("gameweekId") REFERENCES "gameweek"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture" ADD CONSTRAINT "fixture_homeClubSeasonId_fkey" FOREIGN KEY ("homeClubSeasonId") REFERENCES "club_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture" ADD CONSTRAINT "fixture_awayClubSeasonId_fkey" FOREIGN KEY ("awayClubSeasonId") REFERENCES "club_season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
