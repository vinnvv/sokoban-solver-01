# Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/vinnvv/sokoban-solver-01/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/vinnvv/sokoban-solver-01/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for [Build the best Sokoban solver, 21 November 2026](https://make.fun/c/sokoban-solver-01-run-20261121) on make.fun. It reads each level in XSB and writes the player's moves that push every box onto a goal in the fewest pushes possible.

## How it works

The levels this competition draws are a hallway with small rooms off it, each room holding 3 or 4 boxes and as many goals, and the level's push optimum is the sum of its rooms' optima: a box pushed out of a room into the hallway can never come back, so every box stays in its room. The solver uses that shape:

1. It cuts the hallway out of the floor (the dead squares of the player's row) and each part left holding a box is a room.
2. It solves each room on its own with a breadth-first search over pushes, the other rooms' boxes standing as walls, and walks the player from room to room through the hallway.
3. Two prunes keep the search small, and neither can cut a solvable state: dead squares (found by pulling back from the goals) and frozen 2 by 2 blocks of walls and boxes.

A search over pushes, not steps, is what makes the count optimal: the first solved state a push-ordered search meets uses the fewest pushes possible. Everything is budgeted by work, never by the clock, so two runs answer byte for byte alike.

## Results on the practice set

| Instance | Boxes | Push optimum | Solved in |
| --- | --- | --- | --- |
| i001 | 3 | 13 | 13 |
| i002 | 4 | 16 | 16 |
| i003 | 8 | 29 | 29 |
| i004 | 12 | 47 | 47 |
| i005 | 16 | 60 | 60 |

Practice score **1,000,000** (all five instances at their push optimum), against the house baseline's 200,000. The whole set solves in about one second, far inside the 60 second wall budget. Five freshly drawn sets from the same generator also all score 1,000,000.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is a single dependency-free TypeScript file (Node 22, erasable syntax only). It reads `/input/<id>/level.txt` for every instance and writes `/output/<id>/solution.txt` (moves in LURD, a lower letter a step, an upper one a push).
