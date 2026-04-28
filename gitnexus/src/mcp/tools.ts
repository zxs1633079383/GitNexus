/**
 * MCP Tool Definitions
 *
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: unknown;
        items?: { type: string };
        enum?: string[];
        minimum?: number;
        maximum?: number;
        minLength?: number;
      }
    >;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to GitNexus.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group (merged via RRF), or "@<groupName>/<groupRepoPath>" to run against a single member (same path keys as in group.yaml). If you use "@<groupName>" only, the member repo defaults to the lexicographically first key in group.yaml "repos". Prefer resources for contracts/status (see migration from legacy group_* tools).

SERVICE: optional monorepo path prefix (POSIX-style, case-sensitive segments). When "repo" starts with "@", only processes whose symbols fall under that prefix are included. For a normal indexed repo name (no leading @), this field is currently ignored by the server.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: {
          type: 'string',
          description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.',
        },
        goal: {
          type: 'string',
          description:
            'What you want to find (e.g., "existing auth validation logic"). Helps ranking.',
        },
        limit: {
          type: 'number',
          description: 'Max processes to return (default: 5)',
          default: 5,
          minimum: 1,
          maximum: 100,
        },
        max_symbols: {
          type: 'number',
          description: 'Max symbols per process (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 200,
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>" (member path keys from group.yaml). Omit when only one indexed repo exists.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path, "/" separators). In group mode (@repo), prefix-matches symbol file paths; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, Route, Tool
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

• Find all methods of a class:
  MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name, m.parameterCount, m.returnType

• Find all properties of a class:
  MATCH (c:Class {name: "User"})-[r:CodeRelation {type: 'HAS_PROPERTY'}]->(p:Property) RETURN p.name, p.declaredType

• Find all writers of a field:
  MATCH (f:Function)-[r:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property) WHERE p.name = "address" RETURN f.name, f.filePath

• Find method overrides (MRO resolution):
  MATCH (winner:Method)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(loser:Method) RETURN winner.name, winner.filePath, loser.filePath, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm). Properties: heuristicLabel, cohesion, symbolCount, keywords, description, enrichedBy
- Process = execution flow trace from entry point to terminal. Properties: heuristicLabel, processType, stepCount, communities, entryPointId, terminalId
- Use heuristicLabel (not label) for human-readable community/process names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements, methods, properties, overrides), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns ranked candidates (each with a relevance score) for you to pick from. Use uid for zero-ambiguity lookup, or narrow the search with file_path and/or kind hints.

NOTE: ACCESSES edges (field read/write tracking) are included in context results with reason 'read' or 'write'. CALLS edges resolve through field access chains and method-call chains (e.g., user.address.getCity().save() produces CALLS edges at each step).

GROUP MODE: set "repo" to "@<groupName>" to run context in each member repo (aggregated list), or "@<groupName>/<groupRepoPath>" for one member. If you use "@<groupName>" only, the member defaults to the lexicographically first key in group.yaml "repos".

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", prefix-matches resolved symbol file paths; when a hit is outside the prefix, that member returns an empty payload for the symbol. Ignored for a normal indexed repo name.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)',
        },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies in group mode (@repo) only; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          default: 'unstaged',
        },
        base_ref: {
          type: 'string',
          description: 'Branch/commit for "compare" scope (e.g., "main")',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity)',
        },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: {
          type: 'boolean',
          description: 'Preview edits without modifying files (default: true)',
          default: true,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: all affected symbols grouped by traversal depth

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

TIP: Default traversal uses CALLS/IMPORTS/EXTENDS/IMPLEMENTS. For class members, include HAS_METHOD and HAS_PROPERTY in relationTypes. For field access analysis, include ACCESSES in relationTypes.

Handles disambiguation: when multiple symbols share the target name, returns ranked candidates (each with a relevance score) instead of silently picking one. Use target_uid for zero-ambiguity lookup, or narrow with file_path and/or kind hints.

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES
Confidence: 1.0 = certain, <0.8 = fuzzy match

GROUP MODE: set "repo" to "@<groupName>" for cross-repo impact anchored at the default member (lexicographically first key in group.yaml "repos"), or "@<groupName>/<groupRepoPath>" to choose the member (same path keys as in group.yaml). Phase-1 walk runs in that member; cross-boundary fan-out uses the group bridge.

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", scopes the local impact walk and cross-repo symbol paths to files under that prefix; ignored for a normal indexed repo name.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        target_uid: {
          type: 'string',
          description:
            'Direct symbol UID from prior tool results (zero-ambiguity lookup, skips target resolution)',
        },
        direction: {
          type: 'string',
          description: 'upstream (what depends on this) or downstream (what this depends on)',
        },
        file_path: {
          type: 'string',
          description: 'File path hint to disambiguate common names',
        },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        maxDepth: {
          type: 'number',
          description: 'Max relationship depth (default: 3, server clamps to 1–32)',
          default: 3,
          minimum: 1,
          maximum: 32,
        },
        crossDepth: {
          type: 'number',
          description:
            'Cross-repository hop depth via contract bridge (default: 1; values above server maximum are clamped)',
          default: 1,
          minimum: 1,
          maximum: 32,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES (default: usage-based, ACCESSES excluded by default)',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: {
          type: 'number',
          description:
            'Minimum edge confidence 0–1 (default: 0 when omitted; server clamps to 0–1)',
          default: 0,
          minimum: 0,
          maximum: 1,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies when "repo" is group mode (@…); ignored for a normal repo name. Empty string is rejected server-side.',
        },
        subgroup: {
          type: 'string',
          description:
            'Optional group subgroup prefix (member repo paths) limiting which repos participate in cross fan-out.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wall-clock budget in milliseconds for the Phase-1 local impact leg (default 30000)',
          minimum: 1,
          maximum: 3600000,
        },
        timeout: {
          type: 'number',
          description: 'Alias of timeoutMs (milliseconds) when timeoutMs is omitted',
          minimum: 1,
          maximum: 3600000,
        },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'route_map',
    description: `Show API route mappings: which components/hooks fetch which API endpoints, and which handler files serve them.

WHEN TO USE: Understanding API consumption patterns, finding orphaned routes. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
AFTER THIS: Use impact() on specific route handlers to see full blast radius.

Returns: route nodes with their handlers, middleware wrapper chains (e.g., withAuth, withRateLimit), and consumers.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Filter by route path (e.g., "/api/grants"). Omit for all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'tool_map',
    description: `Show MCP/RPC tool definitions: which tools are defined, where they're handled, and their descriptions.

WHEN TO USE: Understanding tool APIs, finding tool implementations, impact analysis for tool changes.

Returns: tool nodes with their handler files and descriptions.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Filter by tool name. Omit for all tools.' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'shape_check',
    description: `Check response shapes for API routes against their consumers' property accesses.

WHEN TO USE: Detecting mismatches between what an API route returns and what consumers expect. Finding shape drift. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
REQUIRES: Route nodes with responseKeys (extracted from .json({...}) calls during indexing).

Returns routes that have both detected response keys AND consumers. Shows top-level keys each endpoint returns (e.g., data, pagination, error) and what keys each consumer accesses. Reports MISMATCH status when a consumer accesses keys not present in the route's response shape.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Check a specific route (e.g., "/api/grants"). Omit to check all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'api_impact',
    description: `Pre-change impact report for an API route handler.

WHEN TO USE: BEFORE modifying any API route handler. Shows what consumers depend on, what response fields they access, what middleware protects the route, and what execution flows it triggers. Requires at least "route" or "file" parameter.

Risk levels: LOW (0-3 consumers), MEDIUM (4-9 or any mismatches), HIGH (10+ consumers or mismatches with 4+ consumers). Mismatches with confidence "low" indicate the consumer file fetches multiple routes — property attribution is approximate.

Returns: single route object when one match, or { routes: [...], total: N } for multiple matches. Combines route_map, shape_check, and impact data.`,
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
        file: { type: 'string', description: 'Handler file path (alternative to route)' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'group_list',
    description: `List all configured repository groups, or return details for one group (repos, manifest links).

WHEN TO USE: Discover groups before group_sync. Optional "name" returns a single group's config.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name. Omit to list all groups.' },
      },
      required: [],
    },
  },
  {
    name: 'group_sync',
    description: `Rebuild the Contract Registry (contracts.json) for a group: extract HTTP contracts, apply manifest links, exact-match cross-links.

WHEN TO USE: After changing group.yaml or re-indexing member repos.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        skipEmbeddings: {
          type: 'boolean',
          description: 'Exact + BM25 only (Demo PR: same as default exact path)',
        },
        exactOnly: { type: 'boolean', description: 'Exact match only in cascade' },
      },
      required: ['name'],
    },
  },
  // ─── Phase 0 / Stage 2 · Trace2Code Resolver ────────────────────────
  // 把一条 Jaeger / OTel span (双格式) 翻译成 handler symbol UID。
  // 是 7 阶段 Agentic DevOps 闭环的"锚点层"——所有 trace → 代码反查的起点。
  // 业务零侵入 (RULES §0.3): 输入用 OTel auto-instrument 的标准字段。
  {
    name: 'resolve_span',
    description: `Map a Jaeger/OTel span to a code handler symbol (Phase 0 — Trace2Code Resolver).

Accepts either a single span or a Jaeger Query API envelope { data: [{ spans: [...] }] }.
Supports two attribute containers:
- Jaeger:  span.tags = [{key, value}, ...]
- OTel:    span.attributes = {"http.route": "...", ...}

5-layer HTTP fallback chain (high → low priority):
  1. http.route      framework template (most precise)
  2. url.path        OTel ≥1.21 new conv
  3. url.full        OTel ≥1.21 full URL (path stripped out)
  4. http.url        OTel ≤1.20 old conv (path stripped out)
  5. http.target     legacy

Other kinds: gRPC (rpc.service + rpc.method) / topic (messaging.destination) /
code.function + code.filepath / OTel exception event top frame.

Output:
- kind:        'http' | 'grpc' | 'topic' | 'code' | 'unknown'
- contractId:  for HTTP this is http::<METHOD>::<consumer-normalized path>
               (numeric segments → {param}, lowercase) — used to look up Route nodes.
- symbolUid:   GitNexus symbol UID (when graph lookup succeeds)
- hops:        which fallback layer matched (diagnostic)
- resolvedBy:  'route-lookup' | 'stacktrace' | 'code-attr' | 'none'
- errorEvent:  parsed OTel exception event with stacktrace top frame

WHEN TO USE: trace observed an error → caller hands off the span here →
output feeds Stage 3 (impact / blast radius) and Stage 4 (regression forensics).

NOTE: This tool is query-time only. The normalizer never runs in the ingestion
pipeline (RULES §0.4 LLM-boundary equivalent).`,
    inputSchema: {
      type: 'object',
      properties: {
        span: {
          type: 'object',
          description:
            'Jaeger span or full Jaeger Query API envelope. Both tags[] and attributes{} are accepted.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['span'],
    },
  },
  // ─── Stage 3 · Blast Radius (Agentic DevOps wrapper) ────────────────
  // 复用 OSS 已有 impact()，给 Agentic DevOps caller 一个语义化、有 sensible
  // defaults 的入口。roadmap §3 锚点工具：「X 改动会影响 Y」必须有确定性
  // 图谱在背后撑着 — 这是闭环可信任性的 anchor。
  {
    name: 'api_blast_radius',
    description: `Compute the blast radius of changing a code symbol — Agentic DevOps wrapper around impact().

Wraps GitNexus impact() with sensible defaults tuned for the 7-stage Agentic
DevOps loop: depth=2 (direct + indirect), cross_depth=1 (one cross-repo hop).
Stage 4 (P5 Auto Regression Forensics) consumes this to compute
suspects = recent commits ∩ blast radius.

DIRECTION:
- 'downstream' (default): what depends on this symbol → which sites break if it changes
- 'upstream':              what this symbol depends on
- 'both':                  union of both directions, deduped by uid

WHY a thin wrapper instead of just calling impact()? Same reason MCP exposes
api_impact: callers should see one Agentic DevOps verb ("blast radius") with
locked-in defaults, not have to re-derive depth/cross_depth conventions per call.

OUTPUT: same shape as impact() — risk / summary / affected_processes /
affected_modules / byDepth — but always with depth=2 + cross_depth=1 unless
overridden.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        target_uid: {
          type: 'string',
          description: 'Direct symbol UID (zero-ambiguity lookup, skips name resolution)',
        },
        file_path: { type: 'string', description: 'File path hint to disambiguate common names' },
        kind: {
          type: 'string',
          description: "Kind filter: 'Function' | 'Class' | 'Method' | 'Interface' | 'Constructor'",
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream', 'both'],
          description: 'Default: downstream (what depends on this)',
          default: 'downstream',
        },
        depth: {
          type: 'number',
          description: 'Local traversal depth (default: 2; Agentic DevOps baseline)',
          default: 2,
          minimum: 1,
          maximum: 32,
        },
        cross_depth: {
          type: 'number',
          description: 'Cross-repo hops via contract bridge (default: 1)',
          default: 1,
          minimum: 1,
          maximum: 32,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter — same set as impact()',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  // ─── Stage 4 · Auto Regression Forensics (P5) ───────────────────────
  // git log ∩ blast radius. caller 传 NormalizedSpan[] (或 SpanInput[]),
  // 输出嫌疑提交清单 + 置信度。Fix-1 强制文件路径过滤防误报。
  {
    name: 'regression_forensics',
    description: `Find recent commits that likely caused the failures observed in a set of spans.

Algorithm (deterministic, no LLM):
  1. For each input span (Phase 0 NormalizedSpan or raw Jaeger/OTel span),
     resolve handler symbolUid via Phase 0 (stacktrace / code.* / Route lookup).
  2. For each handler, compute blast radius (api_blast_radius depth=2 cross=1).
  3. Pull \`git log -n <lookback> --name-only\` from the repo.
  4. Filter commits where touched files ∩ (handler-file ∪ blast radius files) ≠ ∅.
     (Fix-1: file-path filter is mandatory — without it, unrelated same-window
     commits are misattributed.)
  5. Rank by confidence / log(timeAgoSec + 2). Default Top 10.

OUTPUT:
- lookback:     how many commits scanned
- handlerCount: how many input spans had errorEvent + resolved symbolUid
- suspectCount: total ranked suspects
- suspects:     [{commitHash, shortHash, authorTimeSec, timeAgoSec, subject,
                  changedFiles, matchedHandlers, confidence, hitKind}]
                hitKind ∈ {'handler-file', 'blast-d1', 'blast-d2', 'cross-repo'}

WHEN TO USE: Stage 4 of the Agentic DevOps loop — given an Issue with traceId
+ Jaeger spans, ask: which recent commits could have introduced this regression?
Output feeds Stage 5 (test gen) + Stage 7 (auto-PR with revert proposal).`,
    inputSchema: {
      type: 'object',
      properties: {
        spans: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of Jaeger/OTel spans (raw) or NormalizedSpan objects.',
        },
        lookback: {
          type: 'number',
          description: 'How many recent commits to scan (default: 50)',
          default: 50,
          minimum: 1,
          maximum: 500,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['spans'],
    },
  },
  // ─── Stage 5 · E2E Test Generator (P4, R-1 scaffold-only) ───────────
  // 三层 test (unit + contract + integration) 调用链结构骨架。Stage 6 直接消费。
  {
    name: 'gen_e2e_tests',
    description: `Generate three-layer test scaffolds (unit + contract + integration) for a handler.

R-1 (降期望): only the call-chain SKELETON + TODO comments are generated.
DB seed / mock schema / business assertions are explicitly left to the developer.
Stage 6 (preview env) verifies "the call chain runs", not "business is correct".

R-7 layer rules:
- Unit:        Method / Function leaves with no STEP_IN_PROCESS successor
- Contract:    Route nodes OR nodes with ContractLink edges (HANDLES_ROUTE / FETCHES)
- Integration: ENTRY_POINT_OF → STEP_IN_PROCESS chain ≥ 2 hops

Languages supported (R-13: satisfies Record): java/kotlin (JUnit5), typescript /
javascript (Jest), go (testing), python (pytest). Other languages → all three layers
skipped with a 'no adapter' note (caller can drop down to the static call-chain JSON
returned in plan.layers).

OUTPUT:
- language / framework
- plan.layers.{unit, contract, integration}: classified ChainNode[]
- plan.integrationPath:                        the call chain to replay
- files: [{filePath, layer, content}]          ready-to-write scaffolds
- skipped: [{layer, reason}]                   why some layers got nothing

WHEN TO USE: Stage 5 of the loop. Caller gives a target handler (typically the
top suspect from regression_forensics or the symbolUid from resolve_span);
GitNexus emits scaffolds Stage 6 K8s preview env can mount + run.`,
    inputSchema: {
      type: 'object',
      properties: {
        target_uid: {
          type: 'string',
          description: 'Handler symbol UID (typically from resolve_span / regression_forensics).',
        },
        max_depth: {
          type: 'number',
          description: 'BFS max depth into the Process chain (default: 6)',
          default: 6,
          minimum: 1,
          maximum: 32,
        },
        max_nodes: {
          type: 'number',
          description: 'BFS max nodes (default: 200)',
          default: 200,
          minimum: 1,
          maximum: 5000,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['target_uid'],
    },
  },
  {
    name: 'validate_in_preview',
    description:
      'Stage 6 (异步, R-3)：把候选 fix 镜像跑进临时 K8s namespace 跑测试。立刻返回 jobId（spinUp + test 通常 3-5 分钟），用 check_preview_status 轮询。namespace 强制 gitnexus-preview- 前缀，绝不影响生产。',
    inputSchema: {
      type: 'object',
      properties: {
        service_image: {
          type: 'string',
          description: '候选 fix 的服务镜像（已经存在于可拉的 registry）',
        },
        service_name: {
          type: 'string',
          description: 'Deployment / Service 的 name (k8s 合规小写)',
        },
        service_port: { type: 'number', description: '默认 80' },
        test_image: { type: 'string', description: '测试 runner 容器镜像' },
        test_command: {
          type: 'array',
          items: { type: 'string' },
          description: '测试容器启动命令；推荐让测试容器把 JUnit XML 包在 ===JUNIT-XML=== / ===END-JUNIT-XML=== marker 内打到 stdout',
        },
        junit_output_path: {
          type: 'string',
          description: '保留字段 — 当前 collector 走 stdout marker 不读文件',
        },
        ttl_seconds: { type: 'number', description: 'preview namespace TTL，默认 1800 (30min)' },
        repo: { type: 'string', description: 'Optional repo selector' },
      },
      required: ['service_image', 'service_name', 'test_image', 'test_command'],
    },
  },
  {
    name: 'check_preview_status',
    description:
      'Stage 6 (R-3)：查 validate_in_preview 返回的 jobId 当前状态。状态机：queued → spinning_up → running_tests → collecting → done|failed。done 时同时返回 testResult (含 JUnit 详情)。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'validate_in_preview 返回的 jobId' },
        repo: { type: 'string', description: 'Optional repo selector' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'auto_pr',
    description:
      'Stage 7 (R-4 双 App): 把候选 fix 走 policy 校验 → branch (Fix-11 ts 后缀) → put-files → 创建 PR/MR。默认 dryRun=true 不真发；GITNEXUS_AUTOPR_LIVE=1 + GITNEXUS_AUTOPR_TOKEN 配对启用 live。policy 默认 block .github/workflows/** + .env + .pem + .key (R-12)。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          description: 'PRCandidate { owner, repo, baseBranch, title, bodyMarkdown, files[], labels?, draft?, suspectCommit?, issueRef? }',
        },
        provider: { type: 'string', enum: ['github', 'gitlab'], description: '默认 github' },
        dryRun: { type: 'boolean', description: '默认 true，不真发；live 模式需 GITNEXUS_AUTOPR_LIVE=1' },
        stage6Pass: { type: 'boolean', description: 'Stage 6 是否拿到绿勾（policy.require_stage6_pass 闸）' },
        policy: { type: 'object', description: 'AutoPRPolicy partial — 与 default 合并' },
      },
      required: ['candidate'],
    },
  },
  {
    name: 'run_pipeline',
    description:
      'Agentic DevOps 横切：把 spans 一次喂入 4 阶段（resolve_span → api_blast_radius → regression_forensics → gen_e2e_tests），返回逐 stage 结果 + 总耗时；S6/S7 现阶段 stub。',
    inputSchema: {
      type: 'object',
      properties: {
        spans: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Jaeger / OTel spans 数组（与 resolve_span 相同 schema）。必须非空。',
        },
        forensicsLookback: {
          type: 'number',
          description: 'regression_forensics 往前看几个 commit。默认 50。',
        },
        blast_depth: {
          type: 'number',
          description: 'api_blast_radius 本地深度，默认 2',
        },
        blast_cross_depth: {
          type: 'number',
          description: 'api_blast_radius 跨仓深度，默认 1',
        },
        testLanguageHint: {
          type: 'string',
          description: 'gen_e2e_tests 语言提示；省略则按 handler-file 后缀推断。',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['spans'],
    },
  },
];
