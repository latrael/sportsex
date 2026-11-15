# sportsex — 2025/26 Valuation Engine Backtest Report (R3.6 / R3.7)

Generated deterministically from the 2025/26 backfilled season (`npx tsx src/scripts/backtest-2526.ts`).

## 1. Position Cohort Z-Score Verification (R3.1)

| Position | Active Appearances (`minutes > 0`) | Z-Score Mean | Z-Score SD | Raw Mean | Raw SD |
|---|---:|---:|---:|---:|---:|
| **GKP** | 757 | 0.000000 | 1.000000 | 0.6925 | 0.8468 |
| **DEF** | 3904 | -0.000000 | 1.000000 | 0.9113 | 0.9717 |
| **MID** | 5288 | 0.000000 | 1.000000 | 0.9033 | 0.9139 |
| **FWD** | 1412 | -0.000000 | 1.000000 | 0.8012 | 1.0684 |

## 2. Price Distribution Checkpoints (GW1 / GW10 / GW20 / GW38)

| Gameweek | Min | P5 | P25 | Median (P50) | Mean | P75 | P95 | Max | P95 / P5 Ratio | Top 100 (GKP / DEF / MID / FWD) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **GW1** | 16.09 | 19.35 | 28.43 | 29.69 | 89.31 | 119.20 | 324.32 | 1404.28 | **16.76x** | 5 / 39 / 51 / 5 |
| **GW10** | 12.97 | 18.63 | 24.72 | 25.56 | 78.29 | 96.36 | 282.96 | 841.50 | **15.18x** | 6 / 36 / 50 / 8 |
| **GW20** | 14.23 | 19.22 | 25.08 | 26.58 | 77.54 | 108.58 | 269.77 | 599.95 | **14.03x** | 6 / 40 / 45 / 9 |
| **GW38** | 13.92 | 18.91 | 23.38 | 26.84 | 73.79 | 102.13 | 248.57 | 877.09 | **13.15x** | 7 / 32 / 47 / 14 |

## 3. Top 25 Players at GW38

| Rank | Player | Club | Pos | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes | Starts |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|
| 1 | **B.Fernandes** (Bruno Borges Fernandes) | MUN | MID | **877.09** | 1.493 | 1.979 | 0.995 | 3065 | 35 |
| 2 | **E.Le Fée** (Enzo Le Fée) | SUN | MID | **421.84** | 0.608 | 1.164 | 0.992 | 2930 | 33 |
| 3 | **Szoboszlai** (Dominik Szoboszlai) | LIV | MID | **393.35** | 0.588 | 0.974 | 0.997 | 3232 | 36 |
| 4 | **Watkins** (Ollie Watkins) | AVL | FWD | **390.86** | 0.475 | 1.443 | 0.874 | 2833 | 33 |
| 5 | **Anderson** (Elliot Anderson) | NFO | MID | **384.51** | 0.733 | 1.137 | 0.856 | 3332 | 37 |
| 6 | **Gabriel** (Gabriel dos Santos Magalhães) | ARS | DEF | **375.39** | 0.963 | 0.877 | 0.852 | 2750 | 30 |
| 7 | **Haaland** (Erling Haaland) | MCI | FWD | **375.14** | 1.183 | 1.163 | 0.643 | 2953 | 34 |
| 8 | **Bruno G.** (Bruno Guimarães Rodriguez Moura) | NEW | MID | **358.88** | 0.892 | 0.771 | 0.834 | 2456 | 27 |
| 9 | **Bowen** (Jarrod Bowen) | WHU | FWD | **349.04** | 0.469 | 0.731 | 0.997 | 3406 | 38 |
| 10 | **Dewsbury-Hall** (Kiernan Dewsbury-Hall) | EVE | MID | **343.70** | 0.634 | 0.585 | 0.971 | 2629 | 30 |
| 11 | **Thiago** (Igor Thiago Nascimento Rodrigues) | BRE | FWD | **341.24** | 0.671 | 0.357 | 0.998 | 3282 | 37 |
| 12 | **Truffert** (Adrien Truffert) | BOU | DEF | **338.07** | 0.525 | 1.110 | 0.887 | 3378 | 38 |
| 13 | **Gibbs-White** (Morgan Gibbs-White) | NFO | MID | **332.30** | 0.582 | 1.440 | 0.721 | 3101 | 35 |
| 14 | **Garner** (James Garner) | EVE | MID | **326.68** | 0.588 | 0.418 | 1.000 | 3413 | 38 |
| 15 | **Senesi** (Marcos Senesi Barón) | BOU | DEF | **321.89** | 0.680 | 0.739 | 0.885 | 3288 | 37 |
| 16 | **Enzo** (Enzo Fernández) | CHE | MID | **321.07** | 0.698 | 0.571 | 0.882 | 3114 | 35 |
| 17 | **O.Dango** (Dango Ouattara) | BRE | MID | **311.59** | 0.643 | 0.681 | 0.848 | 2271 | 25 |
| 18 | **Mavropanos** (Konstantinos Mavropanos) | WHU | DEF | **310.35** | 0.416 | 0.722 | 0.982 | 2532 | 27 |
| 19 | **Mukiele** (Nordi Mukiele) | SUN | DEF | **308.76** | 0.564 | 0.460 | 0.990 | 2784 | 32 |
| 20 | **Tavernier** (Marcus Tavernier) | BOU | MID | **306.02** | 0.573 | 0.723 | 0.851 | 2732 | 31 |
| 21 | **Tarkowski** (James Tarkowski) | EVE | DEF | **305.53** | 0.479 | 0.532 | 0.998 | 3330 | 37 |
| 22 | **Virgil** (Virgil van Dijk) | LIV | DEF | **301.41** | 0.423 | 0.572 | 1.000 | 3420 | 38 |
| 23 | **M.Fernandes** (Mateus Gonçalo Espanha Fernandes) | WHU | MID | **296.20** | 0.336 | 0.522 | 0.995 | 3017 | 35 |
| 24 | **Pedro Porro** (Pedro Porro Sauceda) | TOT | DEF | **286.14** | 0.324 | 0.597 | 0.990 | 2793 | 32 |
| 25 | **Summerville** (Crysencio Summerville) | WHU | MID | **284.46** | 0.317 | 0.472 | 0.982 | 2470 | 29 |

## 4. Top 5 Per Position Group at GW38

### GKP
| Rank | Player | Club | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **Kelleher** | BRE | **254.36** | 0.183 | 0.512 | 0.998 | 3330 |
| 2 | **Hermansen** | WHU | **244.41** | 0.259 | 0.374 | 0.967 | 1620 |
| 3 | **Lammens** | MUN | **208.84** | -0.027 | 0.271 | 0.990 | 2880 |
| 4 | **Roefs** | SUN | **205.73** | 0.183 | -0.102 | 0.995 | 3150 |
| 5 | **Sels** | NFO | **205.53** | 0.016 | 0.170 | 0.987 | 2667 |

### DEF
| Rank | Player | Club | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **Gabriel** | ARS | **375.39** | 0.963 | 0.877 | 0.852 | 2750 |
| 2 | **Truffert** | BOU | **338.07** | 0.525 | 1.110 | 0.887 | 3378 |
| 3 | **Senesi** | BOU | **321.89** | 0.680 | 0.739 | 0.885 | 3288 |
| 4 | **Mavropanos** | WHU | **310.35** | 0.416 | 0.722 | 0.982 | 2532 |
| 5 | **Mukiele** | SUN | **308.76** | 0.564 | 0.460 | 0.990 | 2784 |

### MID
| Rank | Player | Club | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **B.Fernandes** | MUN | **877.09** | 1.493 | 1.979 | 0.995 | 3065 |
| 2 | **E.Le Fée** | SUN | **421.84** | 0.608 | 1.164 | 0.992 | 2930 |
| 3 | **Szoboszlai** | LIV | **393.35** | 0.588 | 0.974 | 0.997 | 3232 |
| 4 | **Anderson** | NFO | **384.51** | 0.733 | 1.137 | 0.856 | 3332 |
| 5 | **Bruno G.** | NEW | **358.88** | 0.892 | 0.771 | 0.834 | 2456 |

### FWD
| Rank | Player | Club | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **Watkins** | AVL | **390.86** | 0.475 | 1.443 | 0.874 | 2833 |
| 2 | **Haaland** | MCI | **375.14** | 1.183 | 1.163 | 0.643 | 2953 |
| 3 | **Bowen** | WHU | **349.04** | 0.469 | 0.731 | 0.997 | 3406 |
| 4 | **Thiago** | BRE | **341.24** | 0.671 | 0.357 | 0.998 | 3282 |
| 5 | **Calvert-Lewin** | LEE | **251.86** | 0.419 | 0.409 | 0.823 | 2721 |

## 5. Acceptance Gate Summary (R3.7)

- **Z-score standardisation (R3.1)**: PASS (mean = 0, sd = 1 for all 4 position cohorts)
- **All 4 position groups in Top 100 (GW38)**: PASS (GKP=7, DEF=32, MID=47, FWD=14)
- **All 4 position groups in Top 100 (GW20)**: GKP=6, DEF=40, MID=45, FWD=9
- **5th–95th percentile price ratio >= 10x**: PASS (GW38 P95/P5 = 13.15x [P5=18.91, P50=26.84, P95=248.57]; GW20 P95/P5 = 14.03x)
