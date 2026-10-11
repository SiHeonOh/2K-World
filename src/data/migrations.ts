/**
 * Schema migrations, applied in order at startup. `PRAGMA user_version` holds
 * how many have run. Append new ones; never edit one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 · Phase 0: config, teams, players, ratings, seasons, events
  `
  CREATE TABLE league_config (
    version     INTEGER PRIMARY KEY,
    json        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  );

  CREATE TABLE teams (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    short_name   TEXT    NOT NULL UNIQUE,
    division_id  TEXT    NOT NULL,
    control      TEXT    NOT NULL CHECK (control IN ('ai', 'user', 'frozen')),
    colors       TEXT    NOT NULL DEFAULT '[]',
    sort_order   INTEGER NOT NULL
  );

  CREATE TABLE players (
    id          TEXT    PRIMARY KEY,
    team_id     TEXT    NOT NULL REFERENCES teams (id),
    name        TEXT    NOT NULL,
    slot_id     TEXT,
    height      TEXT    NOT NULL DEFAULT '',
    height_cm   REAL,
    nicknames   TEXT    NOT NULL DEFAULT '[]',
    notes       TEXT    NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL
  );
  CREATE INDEX players_by_team ON players (team_id, sort_order);

  -- One row per player per rating column. Number columns use num, grade columns use grade.
  CREATE TABLE ratings (
    player_id  TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
    column_id  TEXT NOT NULL,
    num        REAL,
    grade      TEXT,
    PRIMARY KEY (player_id, column_id)
  );

  CREATE TABLE seasons (
    id          INTEGER PRIMARY KEY,
    label       TEXT    NOT NULL,
    phase       TEXT    NOT NULL,
    started_at  TEXT    NOT NULL
  );

  -- Append-only. Every fact change writes one in the same transaction.
  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,
    season_id   INTEGER REFERENCES seasons (id),
    payload     TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX events_by_type ON events (type, id);
  `,

  // 2 · Phase 1: schedule and results, playoffs, box lines, trades, cards and
  // the draft, the apply-in-2K checklist, awards
  `
  -- Seeds everything the engine draws for a season (schedule order, coin flips).
  ALTER TABLE seasons ADD COLUMN seed TEXT NOT NULL DEFAULT '';
  UPDATE seasons SET seed = lower(hex(randomblob(8))) WHERE seed = '';
  -- Fixed when the regular season ends: overall 1..N ranking (JSON team ids),
  -- and playoff seeds per bracket group (JSON { group: [team ids] }).
  ALTER TABLE seasons ADD COLUMN final_ranking TEXT;
  ALTER TABLE seasons ADD COLUMN playoff_seeds TEXT;
  -- Set when the commissioner closes the draft's protection phase.
  ALTER TABLE seasons ADD COLUMN protection_closed INTEGER NOT NULL DEFAULT 0;

  -- A playoff or play-in pairing. Games point at it; the winner moves on.
  CREATE TABLE series (
    id            INTEGER PRIMARY KEY,
    season_id     INTEGER NOT NULL REFERENCES seasons (id),
    stage         TEXT    NOT NULL CHECK (stage IN ('play-in', 'playoffs', 'finals')),
    round         INTEGER NOT NULL,
    -- Bracket position, unique within a season (e.g. east:r1:1, east:playin:7v8).
    slot          TEXT    NOT NULL,
    conference_id TEXT,
    -- Where each side comes from (a seed, or a winner/loser of another slot), as JSON.
    a_ref         TEXT    NOT NULL,
    b_ref         TEXT    NOT NULL,
    high_team_id  TEXT    REFERENCES teams (id),
    low_team_id   TEXT    REFERENCES teams (id),
    high_seed     INTEGER,
    low_seed      INTEGER,
    best_of       INTEGER NOT NULL,
    winner_id     TEXT    REFERENCES teams (id),
    UNIQUE (season_id, slot)
  );

  CREATE TABLE games (
    id           INTEGER PRIMARY KEY,
    season_id    INTEGER NOT NULL REFERENCES seasons (id),
    stage        TEXT    NOT NULL CHECK (stage IN ('regular', 'play-in', 'playoffs', 'finals')),
    -- Regular season: schedule round. Playoffs: game number within the series.
    round        INTEGER NOT NULL,
    series_id    INTEGER REFERENCES series (id),
    home_id      TEXT    NOT NULL REFERENCES teams (id),
    away_id      TEXT    NOT NULL REFERENCES teams (id),
    home_score   INTEGER,
    away_score   INTEGER,
    status       TEXT    NOT NULL CHECK (status IN ('scheduled', 'final')),
    source       TEXT    CHECK (source IN ('manual', 'screenshot', 'sim')),
    note         TEXT    NOT NULL DEFAULT '',
    recorded_at  TEXT,
    CHECK (status = 'scheduled' OR (home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score))
  );
  CREATE INDEX games_by_season ON games (season_id, stage, round);
  CREATE INDEX games_by_series ON games (series_id);

  -- One row per player per game; stats keyed by stat column id.
  CREATE TABLE box_lines (
    game_id    INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    player_id  TEXT    NOT NULL REFERENCES players (id),
    team_id    TEXT    NOT NULL REFERENCES teams (id),
    row_order  INTEGER NOT NULL,
    stats      TEXT    NOT NULL,
    PRIMARY KEY (game_id, player_id)
  );
  CREATE INDEX box_lines_by_player ON box_lines (player_id);

  CREATE TABLE trades (
    id         INTEGER PRIMARY KEY,
    season_id  INTEGER NOT NULL REFERENCES seasons (id),
    phase      TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('applied', 'vetoed')),
    source     TEXT    NOT NULL CHECK (source IN ('user', 'gm')),
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    vetoed_at  TEXT
  );

  -- Cards the draft hands out by final rank. A traded card keeps its original
  -- team's pick slot; owner_team_id is who holds it now.
  CREATE TABLE cards (
    id                INTEGER PRIMARY KEY,
    -- The draft the card is for; carried-over cards move to the next season's.
    season_id         INTEGER NOT NULL REFERENCES seasons (id),
    -- The season that issued it, so carried cards never clash with new ones.
    issued_season_id  INTEGER NOT NULL REFERENCES seasons (id),
    original_team_id  TEXT    NOT NULL REFERENCES teams (id),
    owner_team_id     TEXT    NOT NULL REFERENCES teams (id),
    number            INTEGER NOT NULL,
    status            TEXT    NOT NULL CHECK (status IN ('held', 'used', 'expired')),
    UNIQUE (issued_season_id, original_team_id, number)
  );

  CREATE TABLE trade_items (
    trade_id      INTEGER NOT NULL REFERENCES trades (id),
    kind          TEXT    NOT NULL CHECK (kind IN ('player', 'card')),
    from_team_id  TEXT    NOT NULL REFERENCES teams (id),
    to_team_id    TEXT    NOT NULL REFERENCES teams (id),
    player_id     TEXT    REFERENCES players (id),
    card_id       INTEGER REFERENCES cards (id),
    -- A traded player's slot before and after, so a veto can put him back.
    from_slot_id  TEXT,
    to_slot_id    TEXT,
    CHECK ((kind = 'player' AND player_id IS NOT NULL) OR (kind = 'card' AND card_id IS NOT NULL))
  );
  CREATE INDEX trade_items_by_trade ON trade_items (trade_id);
  CREATE INDEX trade_items_by_player ON trade_items (player_id);

  CREATE TABLE draft_actions (
    id                INTEGER PRIMARY KEY,
    season_id         INTEGER NOT NULL REFERENCES seasons (id),
    seq               INTEGER NOT NULL,
    team_id           TEXT    NOT NULL REFERENCES teams (id),
    kind              TEXT    NOT NULL CHECK (kind IN ('protect', 'swap', 'pass')),
    card_id           INTEGER REFERENCES cards (id),
    -- protect: the protected player. swap: the team's own player sent out.
    player_id         TEXT    REFERENCES players (id),
    -- swap: the player taken from another team, his team, and both players' new slots.
    target_player_id  TEXT    REFERENCES players (id),
    target_team_id    TEXT    REFERENCES teams (id),
    own_slot_id       TEXT,
    target_slot_id    TEXT,
    created_at        TEXT    NOT NULL,
    vetoed_at         TEXT,
    UNIQUE (season_id, seq)
  );

  -- Moves recorded in the app that still have to be made in 2K.
  CREATE TABLE checklist (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    kind        TEXT    NOT NULL CHECK (kind IN ('trade', 'draft-swap')),
    ref_id      INTEGER NOT NULL,
    team_ids    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    applied_at  TEXT,
    cancelled_at TEXT
  );

  CREATE TABLE awards (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    award_id    TEXT    NOT NULL,
    -- '' for season awards; 'w3' or 'm1' for weekly and monthly ones.
    period      TEXT    NOT NULL DEFAULT '',
    -- 1st, 2nd, 3rd team for selections; 1 otherwise.
    team_rank   INTEGER NOT NULL DEFAULT 1,
    player_id   TEXT    NOT NULL REFERENCES players (id),
    created_at  TEXT    NOT NULL,
    UNIQUE (season_id, award_id, period, team_rank, player_id)
  );
  `,

  // 3 · Phase 2: the AI job queue and the learned name map
  `
  CREATE TABLE jobs (
    id           INTEGER PRIMARY KEY,
    kind         TEXT    NOT NULL,
    status       TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    -- Higher runs first: replies to you > screenshots > reactions > chatter > batch work.
    priority     INTEGER NOT NULL DEFAULT 0,
    input        TEXT    NOT NULL,
    output       TEXT,
    error        TEXT,
    error_kind   TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    -- The job's own folder (screenshots go here); Claude can only read inside it.
    folder       TEXT,
    cost_usd     REAL,
    created_at   TEXT    NOT NULL,
    started_at   TEXT,
    finished_at  TEXT
  );
  CREATE INDEX jobs_by_status ON jobs (status, priority DESC, id);

  -- English names as 2K shows them, matched to players per team. row_order
  -- (the row in that team's box score) tells same-name players apart.
  CREATE TABLE name_map (
    team_id       TEXT    NOT NULL REFERENCES teams (id),
    source        TEXT    NOT NULL,
    player_id     TEXT    NOT NULL REFERENCES players (id),
    row_order     INTEGER,
    confirmed_at  TEXT    NOT NULL,
    PRIMARY KEY (team_id, source, player_id)
  );
  `,

  // 4 · Phase 3: the community
  `
  -- Who writes: fans, reporters, and you ('me').
  CREATE TABLE personas (
    id            TEXT    PRIMARY KEY,
    kind          TEXT    NOT NULL CHECK (kind IN ('fan', 'reporter', 'user')),
    nick          TEXT    NOT NULL UNIQUE,
    -- The school a fan backs; null for neutral fans and reporters.
    team_id       TEXT    REFERENCES teams (id),
    archetype     TEXT    NOT NULL,
    spice         INTEGER NOT NULL CHECK (spice BETWEEN 1 AND 5),
    quirks        TEXT    NOT NULL DEFAULT '[]',
    -- A fan's favourite player (the 'stan' archetype).
    fav_player_id TEXT    REFERENCES players (id),
    outlet        TEXT,
    level         INTEGER NOT NULL DEFAULT 1,
    -- Rumor-minded personas also get 소문 lore, marked unconfirmed.
    rumor         INTEGER NOT NULL DEFAULT 0
  );

  -- Short notes a persona keeps: past takes, grudges, predictions.
  CREATE TABLE persona_memory (
    id          INTEGER PRIMARY KEY,
    persona_id  TEXT    NOT NULL REFERENCES personas (id),
    note        TEXT    NOT NULL,
    job_id      INTEGER REFERENCES jobs (id),
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX persona_memory_by_persona ON persona_memory (persona_id, id DESC);

  CREATE TABLE posts (
    id             INTEGER PRIMARY KEY,
    board_id       TEXT    NOT NULL,
    author_id      TEXT    NOT NULL REFERENCES personas (id),
    kind           TEXT    NOT NULL CHECK (kind IN ('thread', 'article', 'news', 'user', 'live')),
    -- 말머리, e.g. 오피셜, 단독, 찌라시.
    tag            TEXT,
    title          TEXT    NOT NULL,
    body           TEXT    NOT NULL,
    game_id        INTEGER REFERENCES games (id),
    event_id       INTEGER REFERENCES events (id),
    job_id         INTEGER REFERENCES jobs (id),
    views          INTEGER NOT NULL DEFAULT 0,
    up             INTEGER NOT NULL DEFAULT 0,
    down           INTEGER NOT NULL DEFAULT 0,
    my_vote        INTEGER NOT NULL DEFAULT 0 CHECK (my_vote IN (-1, 0, 1)),
    -- How much attention it draws (1-5); views and votes grow with it.
    heat           REAL    NOT NULL DEFAULT 1,
    poten_at       TEXT,
    shown_at       TEXT    NOT NULL,
    last_activity  TEXT    NOT NULL,
    -- When you last opened it, to mark new comments.
    read_at        TEXT
  );
  CREATE INDEX posts_by_board ON posts (board_id, id DESC);
  CREATE INDEX posts_by_poten ON posts (poten_at) WHERE poten_at IS NOT NULL;

  -- Comments trickle in: each is visible from shown_at on.
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts (id),
    parent_id  INTEGER REFERENCES comments (id),
    author_id  TEXT    NOT NULL REFERENCES personas (id),
    body       TEXT    NOT NULL,
    job_id     INTEGER REFERENCES jobs (id),
    up         INTEGER NOT NULL DEFAULT 0,
    down       INTEGER NOT NULL DEFAULT 0,
    my_vote    INTEGER NOT NULL DEFAULT 0 CHECK (my_vote IN (-1, 0, 1)),
    shown_at   TEXT    NOT NULL
  );
  CREATE INDEX comments_by_post ON comments (post_id, shown_at, id);

  -- Written but not shown yet; each refresh reveals the next few. Chatter
  -- written before a newer event (as_of_event) is dropped as stale.
  CREATE TABLE feed_buffer (
    id           INTEGER PRIMARY KEY,
    job_id       INTEGER REFERENCES jobs (id),
    item         TEXT    NOT NULL,
    as_of_event  INTEGER NOT NULL,
    stale_after_event INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL
  );

  -- Small key/value state for the story engine, e.g. the last event it reacted to.
  CREATE TABLE story_state (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  -- The community reacts to events from here on: a league made before it
  -- existed doesn't get a flood of old news; a new league reacts to all.
  INSERT INTO story_state (key, value) SELECT 'events-handled', COALESCE(MAX(id), 0) FROM events;
  `,

  // 5 · Phase 3: indexes for "was this job saved?" and the busiest threads
  `
  CREATE INDEX posts_by_job ON posts (job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX comments_by_job ON comments (job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX feed_buffer_by_job ON feed_buffer (job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX persona_memory_by_job ON persona_memory (job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX posts_by_activity ON posts (last_activity DESC);
  CREATE INDEX posts_by_game ON posts (game_id) WHERE game_id IS NOT NULL;
  `,

  // 6 · Phase 4: the wiki
  `
  CREATE TABLE wiki_pages (
    id           INTEGER PRIMARY KEY,
    title        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    kind         TEXT    NOT NULL CHECK (kind IN ('player', 'team', 'league', 'season', 'rules', 'awards', 'draft', 'topic', 'page')),
    -- The player, team or season a page is about; null for the rest.
    ref_id       TEXT,
    current_rev  INTEGER,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );
  CREATE UNIQUE INDEX wiki_pages_by_ref ON wiki_pages (kind, ref_id) WHERE ref_id IS NOT NULL;
  CREATE INDEX wiki_pages_by_update ON wiki_pages (updated_at DESC);

  -- Every saved version. author_id: 'system' (seeded), 'me' (you), or a persona id.
  CREATE TABLE wiki_revisions (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES wiki_pages (id),
    rev         INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    author_id   TEXT    NOT NULL,
    summary     TEXT    NOT NULL DEFAULT '',
    job_id      INTEGER REFERENCES jobs (id),
    size_delta  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    UNIQUE (page_id, rev)
  );
  CREATE INDEX wiki_revisions_by_job ON wiki_revisions (job_id) WHERE job_id IS NOT NULL;

  -- Links in each page's current text, for 역링크 and red links.
  CREATE TABLE wiki_links (
    from_page  INTEGER NOT NULL REFERENCES wiki_pages (id),
    to_title   TEXT    NOT NULL COLLATE NOCASE,
    PRIMARY KEY (from_page, to_title)
  );
  CREATE INDEX wiki_links_by_target ON wiki_links (to_title);
  `,

  // 7 · Phase 5: player mood history (one snapshot per player after each of his team's games or moves)
  `
  CREATE TABLE player_mood (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    player_id   TEXT    NOT NULL REFERENCES players (id),
    overall     INTEGER NOT NULL,
    band        TEXT    NOT NULL,
    parts       TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX player_mood_by_player ON player_mood (player_id, season_id, id DESC);
  `,

  // 8 · Phase 5: the lore suggestion inbox (제안함). Nothing here is lore until approved.
  `
  CREATE TABLE suggestions (
    id           INTEGER PRIMARY KEY,
    kind         TEXT    NOT NULL CHECK (kind IN ('draft', 'nickname', 'relationship', 'trait', 'fact')),
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    -- A player id, or a team id for a school or its GM.
    target_kind  TEXT    NOT NULL CHECK (target_kind IN ('player', 'team', 'gm')),
    target_id    TEXT    NOT NULL,
    -- What approving changes (JSON, see LorePatch).
    patch        TEXT    NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    source       TEXT    NOT NULL DEFAULT '{}',
    -- The same thing suggested again merges into the waiting card.
    dedupe       TEXT    NOT NULL,
    times        INTEGER NOT NULL DEFAULT 1,
    season_id    INTEGER REFERENCES seasons (id),
    round        INTEGER,
    job_id       INTEGER REFERENCES jobs (id),
    -- The lore file approving wrote to.
    file         TEXT,
    auto         INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    decided_at   TEXT
  );
  CREATE UNIQUE INDEX suggestions_waiting ON suggestions (dedupe) WHERE status = 'pending';
  CREATE INDEX suggestions_by_status ON suggestions (status, id DESC);
  CREATE INDEX suggestions_by_dedupe ON suggestions (dedupe);
  CREATE INDEX suggestions_by_job ON suggestions (job_id) WHERE job_id IS NOT NULL;
  `,

  // 9 · Phase 5: AI GMs. Trade windows, the negotiations in them, and each GM's memory.
  `
  CREATE TABLE trade_windows (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    -- The round it followed; null when you opened it.
    round       INTEGER,
    -- The season phase it opened in: deals waiting for your approval expire when it changes.
    phase       TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    reason      TEXT    NOT NULL CHECK (reason IN ('scheduled', 'manual')),
    opened_at   TEXT    NOT NULL,
    closed_at   TEXT
  );
  CREATE INDEX trade_windows_by_season ON trade_windows (season_id, id DESC);
  CREATE UNIQUE INDEX trade_windows_one_open ON trade_windows (status) WHERE status = 'open';

  -- Each GM's turn in a window: its stance and plan, and the offer it chose (JSON).
  CREATE TABLE gm_turns (
    id          INTEGER PRIMARY KEY,
    window_id   INTEGER NOT NULL REFERENCES trade_windows (id),
    team_id     TEXT    NOT NULL REFERENCES teams (id),
    output      TEXT    NOT NULL,
    job_id      INTEGER REFERENCES jobs (id),
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX gm_turns_by_window ON gm_turns (window_id);
  CREATE INDEX gm_turns_by_job ON gm_turns (job_id) WHERE job_id IS NOT NULL;

  CREATE TABLE negotiations (
    id          INTEGER PRIMARY KEY,
    window_id   INTEGER NOT NULL REFERENCES trade_windows (id),
    from_team   TEXT    NOT NULL REFERENCES teams (id),
    to_team     TEXT    NOT NULL REFERENCES teams (id),
    status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'agreed', 'accepted', 'rejected', 'failed', 'declined')),
    -- The deal on the table (JSON), from the proposer's side.
    deal        TEXT    NOT NULL,
    trade_id    INTEGER REFERENCES trades (id),
    value_gap   REAL,
    lopsided    INTEGER NOT NULL DEFAULT 0,
    leaked      INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    created_at  TEXT    NOT NULL,
    closed_at   TEXT
  );
  CREATE INDEX negotiations_by_window ON negotiations (window_id);
  CREATE INDEX negotiations_by_trade ON negotiations (trade_id) WHERE trade_id IS NOT NULL;

  -- Every offer, counter and answer, with the message, the private 속마음 and what the GM saw.
  CREATE TABLE negotiation_steps (
    id              INTEGER PRIMARY KEY,
    negotiation_id  INTEGER NOT NULL REFERENCES negotiations (id),
    round           INTEGER NOT NULL,
    team_id         TEXT    NOT NULL REFERENCES teams (id),
    action          TEXT    NOT NULL CHECK (action IN ('offer', 'counter', 'accept', 'reject')),
    deal            TEXT,
    message         TEXT    NOT NULL DEFAULT '',
    private_note    TEXT    NOT NULL DEFAULT '',
    report          TEXT,
    trust           INTEGER,
    job_id          INTEGER REFERENCES jobs (id),
    created_at      TEXT    NOT NULL
  );
  CREATE INDEX negotiation_steps_by_negotiation ON negotiation_steps (negotiation_id, id);
  CREATE INDEX negotiation_steps_by_job ON negotiation_steps (job_id) WHERE job_id IS NOT NULL;

  -- What each GM remembers: its plan, its trust toward other GMs (-100..100), recent decisions.
  CREATE TABLE gm_memory (
    team_id     TEXT PRIMARY KEY REFERENCES teams (id),
    plan        TEXT NOT NULL DEFAULT '{}',
    trust       TEXT NOT NULL DEFAULT '{}',
    notes       TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT NOT NULL
  );
  `,

  // 10 · Phase 5: the AI GMs in the draft. Why each protected or picked whom, and what it said.
  `
  CREATE TABLE draft_notes (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    team_id     TEXT    NOT NULL REFERENCES teams (id),
    kind        TEXT    NOT NULL CHECK (kind IN ('protect', 'swap', 'pass')),
    -- The move it made; null when nothing could be made (e.g. a protection the rules refused).
    action_id   INTEGER REFERENCES draft_actions (id),
    card_id     INTEGER,
    note        TEXT    NOT NULL DEFAULT '',
    quote       TEXT,
    job_id      INTEGER REFERENCES jobs (id),
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX draft_notes_by_season ON draft_notes (season_id, id);
  CREATE INDEX draft_notes_by_job ON draft_notes (job_id) WHERE job_id IS NOT NULL;
  `,

  // 11 · Phase 5: players' own words. A quote (or post) and what it means, at moments that matter.
  `
  CREATE TABLE player_quotes (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons (id),
    player_id   TEXT    NOT NULL REFERENCES players (id),
    team_id     TEXT    NOT NULL REFERENCES teams (id),
    channel     TEXT    NOT NULL CHECK (channel IN ('interview', 'sns', 'none')),
    quote       TEXT    NOT NULL DEFAULT '',
    action      TEXT    NOT NULL CHECK (action IN ('none', 'public_complaint', 'private_request', 'public_request', 'praise_teammate', 'call_out_rival')),
    target_id   TEXT    REFERENCES players (id),
    -- His private reasoning: for you, never for writers.
    note        TEXT    NOT NULL DEFAULT '',
    cause       TEXT    NOT NULL DEFAULT '',
    job_id      INTEGER REFERENCES jobs (id),
    created_at  TEXT    NOT NULL
  );
  CREATE INDEX player_quotes_by_player ON player_quotes (player_id, season_id, id DESC);
  CREATE INDEX player_quotes_by_job ON player_quotes (job_id) WHERE job_id IS NOT NULL;
  `,

  // 12 · Phase 5: lasting feelings. Each mood snapshot also keeps them (trust, attachment, wanting out), for the chart.
  `
  ALTER TABLE player_mood ADD COLUMN feelings TEXT;
  `,

  // 13 · Phase 5: the wiki's 토론 (talk threads), and the disputes behind edit wars.
  `
  CREATE TABLE wiki_threads (
    id           INTEGER PRIMARY KEY,
    page_id      INTEGER NOT NULL REFERENCES wiki_pages (id),
    topic        TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    -- Who started it: you ('user'), editors warring over an edit ('war'), or an editor whose text you changed ('pushback').
    origin       TEXT    NOT NULL CHECK (origin IN ('user', 'war', 'pushback')),
    -- The section in dispute: AI editors leave it alone while the thread is open.
    section      TEXT,
    opened_by    TEXT    NOT NULL,
    -- Completed rounds left before a dispute nobody settles closes itself (null: never).
    rounds_left  INTEGER,
    -- A pushback thread whose editor undid your change (each section gets one such revert, ever).
    reverted     INTEGER NOT NULL DEFAULT 0,
    job_id       INTEGER REFERENCES jobs (id),
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    closed_at    TEXT,
    close_note   TEXT
  );
  CREATE INDEX wiki_threads_by_page ON wiki_threads (page_id, status);
  CREATE INDEX wiki_threads_by_update ON wiki_threads (updated_at DESC);

  -- A thread's lines, numbered #1, #2… 'status' lines are the grey notes (opened, closed, an edit made).
  CREATE TABLE wiki_talk (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES wiki_threads (id),
    n           INTEGER NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'status')),
    author_id   TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    -- The revision a status line points at (an edit the thread made or led to).
    rev         INTEGER,
    job_id      INTEGER REFERENCES jobs (id),
    created_at  TEXT    NOT NULL,
    UNIQUE (thread_id, n)
  );
  CREATE INDEX wiki_talk_by_job ON wiki_talk (job_id) WHERE job_id IS NOT NULL;
  `,

  // 14 · What each AI job asked Claude Code for, the exact model that answered, and the tokens it used
  `
  -- --model and --effort as the last run passed them (an alias like 'sonnet'; effort null: Claude Code's default).
  ALTER TABLE jobs ADD COLUMN asked_model TEXT;
  ALTER TABLE jobs ADD COLUMN asked_effort TEXT;
  -- The exact model that answered (the one with the most output tokens), from Claude Code's modelUsage.
  ALTER TABLE jobs ADD COLUMN model TEXT;
  -- JSON: { models: { <model id>: { input, output, cacheRead, cacheWrite } }, total }, over every attempt.
  ALTER TABLE jobs ADD COLUMN tokens TEXT;
  -- 편집실 → AI 모델 lists the latest finished jobs.
  CREATE INDEX jobs_by_finish ON jobs (finished_at DESC, id DESC) WHERE finished_at IS NOT NULL;
  `,

  // 15 · Phase 5: secret reveals in 제안함. The kind list is a CHECK, so the table is rebuilt
  // (new table, copy, drop, rename) with 'reveal' added, and migration 8's indexes made again.
  `
  CREATE TABLE suggestions_new (
    id           INTEGER PRIMARY KEY,
    kind         TEXT    NOT NULL CHECK (kind IN ('draft', 'nickname', 'relationship', 'trait', 'fact', 'reveal')),
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    -- A player id, or a team id for a school or its GM.
    target_kind  TEXT    NOT NULL CHECK (target_kind IN ('player', 'team', 'gm')),
    target_id    TEXT    NOT NULL,
    -- What approving changes (JSON, see LorePatch).
    patch        TEXT    NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    source       TEXT    NOT NULL DEFAULT '{}',
    -- The same thing suggested again merges into the waiting card.
    dedupe       TEXT    NOT NULL,
    times        INTEGER NOT NULL DEFAULT 1,
    season_id    INTEGER REFERENCES seasons (id),
    round        INTEGER,
    job_id       INTEGER REFERENCES jobs (id),
    -- The lore file approving wrote to.
    file         TEXT,
    auto         INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    decided_at   TEXT
  );
  INSERT INTO suggestions_new (id, kind, status, target_kind, target_id, patch, reason, source, dedupe, times, season_id, round, job_id, file, auto, error, created_at, updated_at, decided_at)
    SELECT id, kind, status, target_kind, target_id, patch, reason, source, dedupe, times, season_id, round, job_id, file, auto, error, created_at, updated_at, decided_at FROM suggestions;
  DROP TABLE suggestions;
  ALTER TABLE suggestions_new RENAME TO suggestions;
  CREATE UNIQUE INDEX suggestions_waiting ON suggestions (dedupe) WHERE status = 'pending';
  CREATE INDEX suggestions_by_status ON suggestions (status, id DESC);
  CREATE INDEX suggestions_by_dedupe ON suggestions (dedupe);
  CREATE INDEX suggestions_by_job ON suggestions (job_id) WHERE job_id IS NOT NULL;
  `,

  // 16 · The team an award winner was on when it was given, so a past award's school stays put
  `
  ALTER TABLE awards ADD COLUMN team_id TEXT REFERENCES teams (id);
  -- Awards given before this: his last box line's team that season (in the order it was
  -- played: the regular season by round, then the playoffs; game id within a round), else his team now.
  UPDATE awards SET team_id = COALESCE(
    (SELECT b.team_id FROM box_lines b JOIN games g ON g.id = b.game_id
     WHERE g.season_id = awards.season_id AND b.player_id = awards.player_id
     ORDER BY g.stage <> 'regular' DESC, g.round DESC, g.id DESC LIMIT 1),
    (SELECT p.team_id FROM players p WHERE p.id = awards.player_id)
  );
  `,

  // 17 · Polls on the boards: a post can carry a question with 2–6 options, which fans (by code) and you vote on.
  `
  CREATE TABLE polls (
    id                  INTEGER PRIMARY KEY,
    post_id             INTEGER NOT NULL UNIQUE REFERENCES posts (id),
    question            TEXT    NOT NULL,
    -- JSON array of the option texts, in order (2-6).
    options             TEXT    NOT NULL,
    season_id           INTEGER REFERENCES seasons (id),
    -- With regular-season games ahead it closes when the next round is complete (the round it was waiting
    -- for, for the screen); otherwise at closes_at.
    closes_after_round  INTEGER,
    closes_at           TEXT,
    -- Fans' votes are planned by code once (0 until then).
    planned             INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL,
    closed_at           TEXT,
    -- The [투표 결과] post written when it closed.
    results_post_id     INTEGER REFERENCES posts (id)
  );
  CREATE INDEX polls_open ON polls (closes_at) WHERE closed_at IS NULL;
  CREATE INDEX polls_by_results ON polls (results_post_id) WHERE results_post_id IS NOT NULL;

  -- One vote per voter per poll; a fan's vote counts from shown_at on, so the numbers grow over hours. Yours is 'me'.
  CREATE TABLE poll_votes (
    poll_id   INTEGER NOT NULL REFERENCES polls (id),
    voter_id  TEXT    NOT NULL REFERENCES personas (id),
    option    INTEGER NOT NULL,
    shown_at  TEXT    NOT NULL,
    UNIQUE (poll_id, voter_id)
  );
  `,

  // 18 · Numbers in AI text that its job's facts don't hold, kept after the one retry: marked for you on screen.
  `
  -- One row per marked text: a post, a comment, a wiki revision (wiki_revisions.id), a 토론 line
  -- (wiki_talk.id) or a player's quote. numbers: JSON, the numbers as written, e.g. ["41", "34.5"].
  CREATE TABLE ai_flags (
    id           INTEGER PRIMARY KEY,
    target_kind  TEXT    NOT NULL CHECK (target_kind IN ('post', 'comment', 'wiki_revision', 'wiki_talk', 'player_quote')),
    target_id    INTEGER NOT NULL,
    numbers      TEXT    NOT NULL,
    job_id       INTEGER REFERENCES jobs (id),
    created_at   TEXT    NOT NULL,
    UNIQUE (target_kind, target_id)
  );
  `,

  // 19 · Game ids are never handed out twice. SQLite reuses the highest id after a delete (a playoff game
  // dropped when a series ends, an unplayed game taken out of a round), so a screenshot reading, its folder or
  // a thread made for the old game could land on the new one. AUTOINCREMENT needs a rebuilt table (new table,
  // copy, drop, rename; foreign keys are off while migrations run, so box lines and posts keep pointing at
  // games). The counter starts past every game id anything ever named, games deleted before this included.
  // Only whole numbers from 1 to 2^31-1 count: a stray value (1e300, 2^62) would set the counter at its end,
  // and every new game would fail. Rows that aren't JSON are skipped (json_extract would throw on them).
  // Self-contained: it touches only games (and its indexes) and sqlite_sequence.
  `
  CREATE TABLE games_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id    INTEGER NOT NULL REFERENCES seasons (id),
    stage        TEXT    NOT NULL CHECK (stage IN ('regular', 'play-in', 'playoffs', 'finals')),
    -- Regular season: schedule round. Playoffs: game number within the series.
    round        INTEGER NOT NULL,
    series_id    INTEGER REFERENCES series (id),
    home_id      TEXT    NOT NULL REFERENCES teams (id),
    away_id      TEXT    NOT NULL REFERENCES teams (id),
    home_score   INTEGER,
    away_score   INTEGER,
    status       TEXT    NOT NULL CHECK (status IN ('scheduled', 'final')),
    source       TEXT    CHECK (source IN ('manual', 'screenshot', 'sim')),
    note         TEXT    NOT NULL DEFAULT '',
    recorded_at  TEXT,
    CHECK (status = 'scheduled' OR (home_score IS NOT NULL AND away_score IS NOT NULL AND home_score <> away_score))
  );
  INSERT INTO games_new (id, season_id, stage, round, series_id, home_id, away_id, home_score, away_score, status, source, note, recorded_at)
    SELECT id, season_id, stage, round, series_id, home_id, away_id, home_score, away_score, status, source, note, recorded_at FROM games;
  DROP TABLE games;
  ALTER TABLE games_new RENAME TO games;
  CREATE INDEX games_by_season ON games (season_id, stage, round);
  CREATE INDEX games_by_series ON games (series_id);
  DELETE FROM sqlite_sequence WHERE name = 'games';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'games', COALESCE(MAX(n), 0) FROM (
    SELECT id AS n FROM games
    UNION ALL SELECT game_id FROM posts
    UNION ALL SELECT json_extract(CASE WHEN json_valid(input) THEN input END, '$.gameId') FROM jobs
    UNION ALL SELECT json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.gameId') FROM events
  ) WHERE typeof(n) = 'integer' AND n BETWEEN 1 AND 2147483647;
  `,
]
