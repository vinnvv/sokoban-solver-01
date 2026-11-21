// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The levels this competition draws are a hallway with small rooms off it, each
// room holding 3 or 4 boxes and as many goals, and the level's push optimum is
// the sum of its rooms' optima: a box pushed out of a room into the hallway can
// never come back, so every box stays in its room. This solver uses that shape:
// it cuts the hallway out of the floor, solves each room on its own with a
// breadth-first search over pushes, and walks the player from room to room.
// A search over pushes, not steps, is what makes the count optimal: the first
// solved state a push-ordered search meets uses the fewest pushes possible.
//
// Two prunes keep the search small, and neither can cut a solvable state:
//   - a dead square: a square from which no sequence of pushes, ignoring the
//     other boxes, can bring a box onto any goal (found by pulling back from
//     the goals). A box on a dead square is lost, so the state is dropped.
//   - a frozen 2x2 block: four squares of walls and boxes holding a box off
//     its goal. No push can break such a block, so the state is dropped.
//
// Three defences keep a freshly drawn set safe, where the plain room-by-room
// search could lose an instance on an unlucky draw:
//   - A room is only finished while the player can still reach its door: the
//     search keeps looking, at the same push count, for a solved state that
//     leaves the exit open. A room that can only be solved push-optimally by
//     trapping the player is scheduled last instead; two such rooms fall back
//     to a search over the whole level.
//   - The hallway row is cut whole as the rooms' separator, so an upper and a
//     lower room whose doors share a column can never merge into one search.
//   - The finished move string is replayed on the full level before it is
//     printed: any illegal step, or a finish that is not solved, falls back
//     to a search over the whole level instead of an illegal answer.
//
// Everything is budgeted by work, never by the clock: each room's search keeps
// at most MAX_STATES states, directions are tried in one fixed order, and
// there is no randomness, so two runs answer byte for byte alike.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Up, down, left, right: step delta, the walking letter, the pushing letter.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// The most states one room's search keeps before it gives up. The rooms this
// generator draws are small (a 6 by 6 slot, 3 or 4 boxes) and solve far inside
// this; the cap only bounds the work on a level shaped differently. It sits
// well above the generator's own 250,000-state guarantee, so a room the
// reference search solves is never cut off by it.
const MAX_STATES = 600_000;

// The most states the whole-level fallback keeps. A search over a whole
// multi-room level meets the product of its rooms' positions, so this is a
// last resort only, kept to the reference search's own budget.
const WHOLE_MAX_STATES = 250_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: its width, walls, goals, boxes and player square. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can still reach a goal: pull back from
 * the goals over open floor. A box at square y can be pulled back onto x when
 * the player could have stood at y - d and pushed it to x, so y is live when
 * y and y - d are both open. Squares never reached are dead.
 */
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest square reached. The
 * lowest square names the region: two states with the same boxes and the same
 * reachable region are the same state, whatever square the player stands on.
 */
function floodLow(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
  w: number,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 by 2 block. */
function frozenBlock(
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
  w: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD letters. */
function walkTo(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
  w: number,
): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of a level: {pushes, moves, exitOk} (moves in
 * LURD, a lower letter a step, an upper one a push), or null when the search
 * gives up or the level has no solution. A breadth-first search over pushes:
 * states are the boxes' squares plus the player's reachable region, expanded
 * in order of pushes made, so the first solved state met is push-optimal.
 *
 * `exit` is the square the player must still be able to reach once the level
 * is solved (-1 for no such demand, as in a search over a whole level). When
 * the first solved state met traps the player away from it, the search keeps
 * going at the same push count for a solved state that leaves the exit open,
 * and only when none exists does it fall back to the trapped one, marked by
 * exitOk false so its caller can schedule that room last.
 */
function solvePushes(
  level: Level,
  maxStates: number,
  exit: number,
): { pushes: number; moves: string; exitOk: boolean } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  const occupied = new Uint8Array(size);
  // seen marks the expanded state's region; mark marks the region of each
  // state a push makes (its key's lowest square). Two arrays, because a
  // candidate's flood must never overwrite the state being expanded.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in the order found: their boxes, the player's square after the
  // push that made them, the push that made them from their parent, and the
  // pushes made to reach them.
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sPushes: number[] = [0];
  const index = new Map<string, number>();
  const keyOf = (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;
  for (const b of level.boxes) occupied[b] = 1;
  const initStamp = ++stamp;
  index.set(keyOf(level.boxes, floodLow(wall, occupied, level.player, seen, initStamp, stack, w)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // The accepted solved state, and the first solved-but-trapped one, with the
  // pushes it took: the search only ever accepts a solved state at that same
  // push count once a trapped one is known, so the answer stays optimal.
  let found = -1;
  let trappedFound = -1;
  let trappedPushes = -1;
  if (solved(level.boxes)) {
    if (exit < 0 || seen[exit] === initStamp) {
      found = 0;
    } else {
      trappedFound = 0;
      trappedPushes = 0;
    }
  }
  outer: for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    // Past the trapped depth there is no push-optimal state left to find.
    if (trappedPushes >= 0 && sPushes[head]! >= trappedPushes) break;
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    floodLow(wall, occupied, sPlayer[head]!, seen, ++stamp, stack, w);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The push square (behind the box) must be one the player reaches,
        // and the target must be open floor, empty, and alive.
        if (seen[b - d] !== here || t < 0 || t >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(wall, occupied, goal, t, w);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, floodLow(wall, occupied, b, mark, ++stamp, stack, w));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          // A trapped solution already found is still push-optimal: keep it
          // rather than nothing.
          if (trappedFound >= 0) {
            found = trappedFound;
            break outer;
          }
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(head);
        sFrom.push(b);
        sTo.push(t);
        sPushes.push(sPushes[head]! + 1);
        if (solved(next!)) {
          // The candidate's region was just flooded into mark with stamp:
          // the exit is open when it carries that stamp.
          if (exit < 0 || mark[exit] === stamp) {
            found = sBoxes.length - 1;
            break;
          }
          if (trappedFound < 0) {
            trappedFound = sBoxes.length - 1;
            trappedPushes = sPushes[head]! + 1;
          }
          // Keep looking: another push-optimal solution may leave the
          // exit open.
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) {
    if (trappedFound >= 0) found = trappedFound;
    else return null;
  }
  const exitOk = exit < 0 || found !== trappedFound;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(wall, occupied, player, from - d, w);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, exitOk };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: the whole hallway row (the player's row) is cut out of
 * the floor as the rooms' separator, and each part left that holds a box is a
 * room. Cutting the row whole, rather than only its dead squares, keeps an
 * upper and a lower room apart even when their doors share a column, where
 * the hallway square between them is not dead. Null when the level is no
 * clean set of rooms: a box or a goal sits in the hallway row, some part
 * holds more or fewer boxes than goals, or a goal lies in the cut.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i]) continue;
    if (boxes.includes(i) || goals.includes(i)) return null;
    cut[i] = 1;
  }
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The square inside a room that opens onto the hallway: the room square
 * beside the player's row. -1 when the room has none.
 */
function doorOf(room: Room, level: Level): number {
  const row = Math.floor(level.player / level.w);
  for (const s of room.squares) {
    for (const d of [level.w, -level.w]) {
      const q = s + d;
      if (q >= 0 && q < level.wall.length && Math.floor(q / level.w) === row && !level.wall[q]) {
        return s;
      }
    }
  }
  return -1;
}

/** A room as a level of its own: the other rooms' boxes stand as walls. */
function subLevel(level: Level, rooms: Room[], room: Room, player: number): Level {
  const wall = level.wall.slice();
  for (const other of rooms) {
    if (other === room) continue;
    for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
  }
  return {
    w: level.w,
    h: level.h,
    wall,
    goals: room.goals.slice().sort((a, b) => a - b),
    boxes: room.boxes.slice().sort((a, b) => a - b),
    player,
  };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's: {pushes,
 * moves}, or null when a room's search gives up, when the level is no set of
 * rooms, or when more than one room can only be solved by trapping the
 * player. A room's push count and whether it traps the player do not depend
 * on the order it is solved in (only its walk does), so a first pass from the
 * player's start learns which rooms trap; a trapping room is then solved
 * last, where ending trapped costs nothing.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  const doors = rooms.map((r) => doorOf(r, level));
  const trapping: boolean[] = [];
  for (let i = 0; i < rooms.length; i++) {
    const solved = solvePushes(subLevel(level, rooms, rooms[i]!, level.player), MAX_STATES, doors[i]!);
    if (solved === null) return null;
    trapping.push(!solved.exitOk);
  }
  if (trapping.filter(Boolean).length >= 2) return null;
  // Non-trapping rooms first, in their old order; a trapping room last.
  const order = rooms.map((_, i) => i).sort((a, b) => Number(trapping[a]) - Number(trapping[b]));
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (let k = 0; k < order.length; k++) {
    const idx = order[k]!;
    const room = rooms[idx]!;
    const isLast = k === order.length - 1;
    const solved = solvePushes(subLevel(level, rooms, room, player), MAX_STATES, isLast ? -1 : doors[idx]!);
    if (solved === null) return null;
    // A non-last room that traps the player after all is not safe to leave:
    // the whole level is the only way left.
    if (!isLast && !solved.exitOk) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Whether `moves` replays legally on the full level and ends with every box
 * on a goal: each step onto open floor, a step into a box pushing it onto
 * open empty floor. The checker decides pushes from the steps alone, so the
 * replay does the same and ignores the moves' case.
 */
function verifyMoves(level: Level, moves: string): boolean {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const boxes = new Set<number>(level.boxes);
  let player = level.player;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const d = lower === 'u' ? -w : lower === 'd' ? w : lower === 'l' ? -1 : lower === 'r' ? 1 : 0;
    if (d === 0) return false;
    const t = player + d;
    if (t < 0 || t >= wall.length || wall[t]) return false;
    if (boxes.has(t)) {
      const beyond = t + d;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || boxes.has(beyond)) return false;
      boxes.delete(t);
      boxes.add(beyond);
    }
    player = t;
  }
  for (const b of boxes) if (!goal[b]) return false;
  return true;
}

/**
 * The moves solving a level, or '' when it cannot be solved within budget.
 * The room-by-room answer is replayed on the full level first; anything
 * wrong with it falls back to a search over the whole level, itself replayed
 * before it is trusted.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null && verifyMoves(level, byRooms.moves)) return byRooms.moves;
  const whole = solvePushes(level, WHOLE_MAX_STATES, -1);
  if (whole !== null && verifyMoves(level, whole.moves)) return whole.moves;
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
