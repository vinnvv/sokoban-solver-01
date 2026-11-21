# Sokoban solver design

Written from the kit itself (RULES.txt, program/generator/subject/generate.mjs,
program/generator/subject/solver.mjs, program/scorer/). No Gemini direction was
obtained for this build: this subagent has no live-browser access, so the
dedicated Gemini session could not be opened. The parent agent should run the
Gemini direction/debate step before submitting, or rely on the grade-check
cron's Gemini debate if a revision is ever needed. The design below is the
recorded agent's own analysis of the kit.

## What the levels are

- One hallway, one square wide, across the middle row. Up to two rooms above
  it and two below, each in a 6 by 6 slot, opening onto the hallway through
  exactly one door. No two doors share a column.
- Each room holds 3 or 4 boxes and as many goals. The room is drawn by reverse
  play (30 to 80 pulls backwards from the solved state) and kept only when the
  reference push-optimal search solves it from its door in at least 12 pushes
  (3 boxes) or 14 (4 boxes).
- A box pushed through a door into the hallway can never be pushed back, so
  every box stays in its room, and the level's push optimum P* is the sum of
  its rooms' optima, known by construction.
- The set grows: 1 room of 3, 1 room of 4, then 2, 3 and 4 rooms of 4.
  Practice P*: 13, 16, 29, 47, 60.

## Scoring (why push-optimality is everything)

- Solved in exactly P* pushes: 1,000 points. Solved in more: 500 x P* / pushes.
  One push over P* earns under half. Unsolved or illegal: 0.
- Score = 1,000 x mean points over 5 instances, 0 to 1,000,000.
- A reward needs all 5 answered AND a score strictly above the house baseline
  (plain-astar 1.0.0). The baseline scores 200,000 on practice (only i001
  solved); a push-optimal entry scores 1,000,000.
- The entry runs twice and both outputs must match byte for byte, so the
  search is budgeted by work (a state cap), never by the clock.

## Solver design

1. Parse the XSB level into walls, goals, boxes, player.
2. Find the rooms: compute live squares by pulling back from the goals, cut
   the dead squares of the player's row (the hallway) out of the floor, and
   flood-fill the rest. Each part holding boxes is a room; a level that does
   not split cleanly falls back to a whole-level search.
3. Solve each room on its own with a breadth-first search over pushes:
   - A state is the boxes' squares plus the player's reachable region, named
     by its lowest square. States expand in order of pushes made, so the first
     solved state met is push-optimal.
   - Prunes, both sound (they never cut a solvable state): dead squares
     (a box on one can never reach a goal) and frozen 2 by 2 blocks.
   - The other rooms' boxes stand as walls (on their goals once their room
     is done); the player walks on from where the last room left it.
4. Reconstruct the moves: shortest walk to each push's square, then the push.
   Walk letters lower case, push letters upper case (the checker ignores case).

## Verification

- Practice set: 1,000,000, all 5 at P*, passed, answered 5 of 5, about 1.7s.
- Baseline on practice: 200,000 (only i001). Margin: 5x.
- Six freshly drawn sets from the same generator (new random seeds):
  all 1,000,000, each instance at its own P* (checked by replay).
- Determinism: two runs byte-identical, on practice and on a fresh draw.
- Grade-local (process driver): score 1,000,000, 5000 of 5000 points,
  two executions reproduced byte for byte.
- One bug found and fixed during testing: the candidate flood fill shared the
  stamp array with the state being expanded, clobbering its region marks and
  killing the search. Fixed with separate stamp arrays (seen vs mark).

## Robustness fixes (Gemini review, 21 Nov 17:08 WIB)

Gemini reviewed this design and found four gaps that could zero an instance
on an unlucky final draw. All four are fixed in main.ts:

1. Player trapped after finishing a room (highest risk). The per-room search
   used to stop at the first push-optimal solved state, which can place the
   last box across the player's exit to the door. Now the search keeps going
   at the same push count for a solved state that leaves the door reachable,
   and only when none exists does it keep the trapped one, marked so the
   room is scheduled last. Two such rooms fall back to a whole-level search.
   The generator's own goal placement already guarantees a solved room
   leaves the exit open, so this is defence in depth, not a live bug.
2. Aligned doors (high risk). The rooms' separator used to cut only the dead
   squares of the hallway row, and the hallway square between two doors in
   one column is not dead, so the two rooms merged into one 6-8 box search
   that blows past the cap. Now the whole hallway row is cut as the
   separator (after confirming no box or goal sits in it), so upper and lower
   rooms never merge. Edge test: a hand-built level with both doors in
   column 5. The old code returns empty after 4.7s (cap hit on the merged
   6-box search); the fixed solver answers it in 0.3s at push optimum
   (12 pushes, verified by replay).
3. State cap raised from 300,000 to 600,000 per room (still work-count
   based, never clock based, so the entry stays deterministic). The
   generator guarantees rooms solve within 250,000, so this is margin.
4. Internal verifier. The finished move string is replayed on the full
   level before it is printed: every step legal, every box on a goal at the
   end. Any anomaly falls back to a whole-level search (250,000 states),
   itself replayed before it is trusted, instead of an illegal answer.
   Edge test: a hand-built level whose one room can only be solved by
   trapping the player (its goal sits on the door square). The old code
   returns empty (it solves that room first and can reach no other); the
   fixed solver schedules it last and answers at push optimum (2 pushes,
   verified by replay).

## Risks

- The scored set is a new draw from the same generator (drand round 34200012,
  after the deadline). The solver was validated on 5 fresh draws plus the
  practice set, all perfect, so the risk is low.
- If a room ever failed to solve within the state cap, that instance would
  score 0 (empty solution, still valid format). The cap is 300,000 states per
  room; the generator guarantees rooms solve within 250,000 with the same
  search shape, and fresh draws solved far inside the cap.
