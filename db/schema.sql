-- Understudy schema
-- CockroachDB v25.2+ (vector indexes). Idempotent, re-runnable.
--
-- RULE: every VECTOR INDEX is declared INLINE in CREATE TABLE, on an empty table.
-- Adding one to a populated table blocks writes for the entire backfill.
--
-- PREREQUISITE: run db/00-enable-vector.sql first (once per cluster).
--
-- Local full reset:
--   cockroach sql --insecure -e "DROP DATABASE understudy CASCADE; CREATE DATABASE understudy;"
--   cockroach sql --insecure -f db/00-enable-vector.sql
--   cockroach sql --insecure -d understudy -f db/schema.sql
--
-- Cloud:
--   cockroach sql --url "$CRDB_URL" -f db/00-enable-vector.sql   # may fail — see that file
--   cockroach sql --url "$CRDB_URL" -e "CREATE DATABASE IF NOT EXISTS understudy;"
--   cockroach sql --url "$CRDB_URL/understudy" -f db/schema.sql

-- ---------------------------------------------------------------------------
-- meta — one row. Guards against mixing vector spaces.
-- Titan v2 and mxbai-embed-large are both 1024-dim but occupy unrelated
-- spaces; mixing them returns confident nonsense with no error.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  embedder_id    STRING NOT NULL,          -- 'mxbai-embed-large' | 'amazon.titan-embed-text-v2:0'
  embedding_dims INT NOT NULL DEFAULT 1024,
  schema_version INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Entities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS apps (
  app_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       STRING NOT NULL UNIQUE,
  name       STRING NOT NULL,
  base_url   STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS environments (
  env_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  name                STRING NOT NULL,
  base_url            STRING NOT NULL,
  allows_purchases    BOOL NOT NULL DEFAULT false,
  allows_irreversible BOOL NOT NULL DEFAULT false,
  requires_seeded_auth BOOL NOT NULL DEFAULT false,
  storage_state_path  STRING,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

-- flows — a named ordered sequence of steps.
-- Recordings, distilled segments, and mined macros are ALL rows here;
-- `source` is the only thing distinguishing them.
CREATE TABLE IF NOT EXISTS flows (
  flow_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  slug          STRING NOT NULL,
  title         STRING NOT NULL,
  intent        STRING NOT NULL,
  preconditions JSONB NOT NULL DEFAULT '[]',
  outcome       STRING,
  start_state   STRING,                    -- sig() at first step
  end_state     STRING,                    -- sig() after last step
  source        STRING NOT NULL DEFAULT 'recorded'
                CHECK (source IN ('recorded','sliced','mined')),
  is_macro      BOOL NOT NULL DEFAULT false,   -- discovered by macro mining
  parent_flow_id UUID REFERENCES flows(flow_id),  -- provenance for sliced segments
  destructive   BOOL NOT NULL DEFAULT false,
  cost_note     STRING,
  needs_review  BOOL NOT NULL DEFAULT false,     -- replay failed; never promoted
  recording_hash STRING,                          -- distillation cache key
  used_by       INT NOT NULL DEFAULT 0,           -- flows containing this macro
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug),
  INDEX flows_app_source_idx (app_id, source),
  INDEX flows_start_state_idx (app_id, start_state),
  INDEX flows_end_state_idx (app_id, end_state)
);

-- selectors — per APP, not per flow. One row per element, one health score.
CREATE TABLE IF NOT EXISTS selectors (
  selector_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  role          STRING,
  name          STRING,
  test_id       STRING,
  css           STRING,
  -- '' means the main frame. NOT NULL is load-bearing, not tidiness: a NULL
  -- component makes UNIQUE(app_id, role, name, frame_hint) inert, because SQL
  -- never treats NULL as equal to NULL. With NULLs the dedupe silently did
  -- nothing and one element became many rows, splitting its health score.
  -- See db/02-selector-frame-hint-not-null.sql.
  frame_hint    STRING NOT NULL DEFAULT '', -- iframe matched by id SUFFIX, never exact
  fallbacks     JSONB NOT NULL DEFAULT '[]',
  fragility     STRING NOT NULL DEFAULT 'unknown'
                CHECK (fragility IN ('stable','positional','hashed','unknown')),
  observed_only BOOL NOT NULL DEFAULT false,   -- seen by explore, never used by a run
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  health        FLOAT,                          -- NULL until a run touches it
  quarantined   BOOL NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- dedupe key: same role+name+frame on one app is ONE row
  UNIQUE (app_id, role, name, frame_hint),
  INDEX selectors_health_idx (app_id, quarantined, health)
);

-- steps — the IR. What to do; selector_id says how to find it.
CREATE TABLE IF NOT EXISTS steps (
  step_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  action      STRING NOT NULL CHECK (action IN (
                'goto','click','fill','press','select','check','upload',
                'wait_url','wait_text','scroll_container','dispatch_click',
                'assert','snapshot')),
  selector_id UUID REFERENCES selectors(selector_id),
  value_ref   STRING,                      -- 'MEMBER.email' — NEVER a credential value
  value_param STRING,                      -- '{{service}}' when distiller detects a parameter
  args        JSONB NOT NULL DEFAULT '{}',
  semantic    STRING NOT NULL,             -- THIS is what gets embedded
  state_after STRING,                      -- sig() after this step
  fingerprint STRING NOT NULL,             -- sha1(action|role|name|url_pattern) — macro mining
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX steps_fingerprint_idx (app_id, fingerprint),
  INDEX steps_selector_idx (selector_id)
);

-- flow_steps — membership. One step row can belong to a recording AND to the
-- segments sliced out of it, at different ordinals, with no duplication.
CREATE TABLE IF NOT EXISTS flow_steps (
  flow_id UUID NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  PRIMARY KEY (flow_id, ordinal),
  INDEX flow_steps_step_idx (step_id)
);

-- ---------------------------------------------------------------------------
-- Knowledge: lessons (fire on a trigger, while running)
--            facts   (retrieved by meaning, while planning)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lessons (
  lesson_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  kind         STRING NOT NULL,
  title        STRING NOT NULL,
  body         STRING NOT NULL,
  fix_snippet  STRING,
  trigger      JSONB NOT NULL DEFAULT '{}',   -- predicate: url, action, role, name
  confidence   FLOAT NOT NULL DEFAULT 0.5,
  times_applied INT NOT NULL DEFAULT 0,
  times_helped  INT NOT NULL DEFAULT 0,
  source       STRING NOT NULL DEFAULT 'distilled'
               CHECK (source IN ('distilled','post_mortem','user_said','promoted_finding')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX lessons_app_idx (app_id, kind)
);

CREATE TABLE IF NOT EXISTS lesson_links (
  lesson_id   UUID NOT NULL REFERENCES lessons(lesson_id) ON DELETE CASCADE,
  target_kind STRING NOT NULL CHECK (target_kind IN ('step','selector','flow')),
  target_id   UUID NOT NULL,
  PRIMARY KEY (lesson_id, target_kind, target_id),
  INDEX lesson_links_target_idx (target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS facts (
  fact_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  kind             STRING NOT NULL CHECK (kind IN (
                     'structure','capability','entity','auth',
                     'environment','boundary','constraint')),
  statement        STRING NOT NULL,
  detail           STRING,
  scope            JSONB NOT NULL DEFAULT '{}',   -- {url_pattern:'/cart'}
  source           STRING NOT NULL CHECK (source IN (
                     'explored','user_said','distilled','inferred')),
  confidence       FLOAT NOT NULL DEFAULT 0.5,    -- user_said .9 distilled .7 explored .5 inferred .3
  observed_count   INT NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by    UUID REFERENCES facts(fact_id), -- keeps the trail, no silent overwrite
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX facts_app_kind_idx (app_id, kind)
);

-- ---------------------------------------------------------------------------
-- Route map — a graph, stored as one. Makes seam resolution a query.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pages (
  page_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  sig           STRING NOT NULL,
  url_pattern   STRING NOT NULL,
  title         STRING,
  requires_auth BOOL NOT NULL DEFAULT false,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, sig)
);

CREATE TABLE IF NOT EXISTS page_edges (
  app_id       UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  from_page    UUID NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  to_page      UUID NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  via_selector UUID REFERENCES selectors(selector_id),
  kind         STRING NOT NULL CHECK (kind IN ('link','reveal','inferred_from_run')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, from_page, to_page, via_selector),
  INDEX page_edges_from_idx (app_id, from_page)
);

-- ---------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  env_id        UUID REFERENCES environments(env_id),
  goal          STRING NOT NULL,
  plan          JSONB NOT NULL DEFAULT '{}',   -- sub-goals, bindings, seams, distances
  mode          STRING NOT NULL DEFAULT 'execute'
                CHECK (mode IN ('execute','emit-only','dry-run')),
  status        STRING NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','passed','failed','blocked','needs_context')),
  sig_sequence  JSONB NOT NULL DEFAULT '[]',   -- observed fingerprint path — flow-drift diff
  reasoner      STRING,                        -- 'bedrock' | 'host-agent'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  INDEX runs_app_started_idx (app_id, started_at DESC)
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ordinal       INT NOT NULL,
  step_id       UUID REFERENCES steps(step_id),
  selector_id   UUID REFERENCES selectors(selector_id),
  outcome       STRING NOT NULL CHECK (outcome IN (
                  'ok','not_found','assert_fail','timeout','healed','skipped','error')),
  error         STRING,
  sig_observed  STRING,
  duration_ms   INT,
  console       JSONB NOT NULL DEFAULT '[]',   -- captured unconditionally
  network       JSONB NOT NULL DEFAULT '[]',   -- method,url,status,req body,res body
  artifact_ref  STRING,                        -- s3 key or local path
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, ordinal),
  INDEX run_events_selector_idx (selector_id, outcome)
);

-- findings — "X is wrong". Distinct from a lesson: a lesson means the agent
-- adapts, a finding means the app gets fixed. Only a human decides which.
CREATE TABLE IF NOT EXISTS findings (
  finding_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  kind          STRING NOT NULL CHECK (kind IN (
                  'console_error','network_error','data_mismatch','persistence',
                  'nondeterminism','flow_drift','perf','other')),
  severity      STRING NOT NULL DEFAULT 'unknown'
                CHECK (severity IN ('high','medium','low','unknown')),
  statement     STRING NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '{}',   -- url, status, bodies, console text, sub-goal
  fingerprint   STRING NOT NULL,               -- dedupe across runs
  occurrences   INT NOT NULL DEFAULT 1,
  first_run_id  UUID REFERENCES runs(run_id),
  last_run_id   UUID REFERENCES runs(run_id),
  status        STRING NOT NULL DEFAULT 'open' CHECK (status IN (
                  'open','triaged_lesson','triaged_issue','wontfix','fixed')),
  promoted_to   UUID REFERENCES lessons(lesson_id),
  external_ref  STRING,                        -- issue URL once filed
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, fingerprint),
  INDEX findings_status_idx (app_id, status, severity)
);

-- context_requests — the gap loop. ALSO the pause-and-ask channel for the
-- host-agent reasoner: same state machine, different asker.
CREATE TABLE IF NOT EXISTS context_requests (
  request_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  run_id       UUID REFERENCES runs(run_id) ON DELETE CASCADE,
  kind         STRING NOT NULL CHECK (kind IN (
                 'record_flow','screenshot','question','decision')),
  status       STRING NOT NULL DEFAULT 'pending' CHECK (status IN (
                 'pending','delivered','answered','ingested','expired')),
  reason       STRING NOT NULL,
  ask          STRING NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  answer       JSONB,
  produced     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  INDEX context_requests_pending_idx (app_id, status, created_at)
);

-- ---------------------------------------------------------------------------
-- Conversation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  summary    STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role       STRING NOT NULL,
  content    STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX messages_session_idx (session_id, created_at)
);

-- ---------------------------------------------------------------------------
-- memory_chunks — ONE ANN index over everything.
--
-- app_id is the ONLY prefix column. Every retrieval is app-scoped; adding
-- `kind` would fragment the index and break returning segments AND lessons
-- AND facts in one scan. `kind` is filtered post-ANN with over-fetch.
-- health/destructive are denormalized so re-rank arithmetic happens in the
-- same scan, before the LIMIT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_chunks (
  chunk_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE like every other app-scoped table. Without it, dropping
  -- an app cascades pages/edges/selectors/facts and silently ORPHANS every
  -- chunk — invisible to queries, permanent in the vector index, and billable
  -- storage on Cloud. See db/01-memory-chunks-fk.sql for existing clusters.
  app_id      UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  kind        STRING NOT NULL CHECK (kind IN (
                'flow','segment','step','lesson','selector','fact',
                'finding','session_summary','answer')),
  ref_id      UUID NOT NULL,
  flow_id     UUID,
  text        STRING NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}',
  health      FLOAT NOT NULL DEFAULT 0.5,
  destructive BOOL  NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding   VECTOR(1024) NOT NULL,

  CONSTRAINT pk_memory_chunks PRIMARY KEY (chunk_id),
  VECTOR INDEX mc_embed_idx (app_id, embedding vector_l2_ops)
    WITH (min_partition_size = 16, max_partition_size = 128),
  INDEX mc_ref_idx (app_id, kind, ref_id)
);
